<?php
/**
 * request_recharge.php — demande de recharge du portefeuille (chauffeur).
 *
 * Lot 8 + sécurité S-D. Règles appliquées ICI, côté serveur (le navigateur
 * peut être contourné) :
 *   - montant entier entre min et max (config/payment.php) ;
 *   - opérateur pris dans la liste de config/payment.php ;
 *   - référence de transaction OBLIGATOIRE (6-40 caractères, lettres/chiffres/. _ -) :
 *     c'est la preuve que l'admin vérifie dans son application mobile money ;
 *   - une même référence (même opérateur) ne peut servir qu'UNE fois
 *     (demande en attente ou déjà validée) : pas de double crédit avec un seul paiement ;
 *   - au plus "max_pending" demandes en attente par chauffeur.
 * Les vérifications et l'insertion se font dans une transaction qui verrouille
 * la ligne du chauffeur : deux envois simultanés ne contournent pas le plafond.
 */
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../config/db.php";
require_once __DIR__ . "/../common/send_push.php";

$driverId = require_driver_id();
$cfg = require __DIR__ . "/../config/payment.php";

$data = json_decode(file_get_contents("php://input"), true);
if (!is_array($data)) {
    json_response(["status" => "error", "message" => "Données JSON invalides"], 400);
}

// ── 1. Validation des champs ─────────────────────────────────────
// FILTER_VALIDATE_INT refuse "12abc", "5.5" et les tableaux (l'ancien (int) les acceptait).
$amount = filter_var($data["amount"] ?? null, FILTER_VALIDATE_INT);
if ($amount === false || $amount < $cfg["min_amount_fcfa"] || $amount > $cfg["max_amount_fcfa"]) {
    json_response(["status" => "error", "message" =>
        "Montant invalide : entre " . number_format($cfg["min_amount_fcfa"], 0, ",", " ")
        . " et " . number_format($cfg["max_amount_fcfa"], 0, ",", " ") . " FCFA"], 400);
}

$operator = isset($data["operator"]) && is_string($data["operator"]) ? trim($data["operator"]) : "";
if (!array_key_exists($operator, $cfg["operators"])) {   // liste blanche : aucun texte libre en base
    json_response(["status" => "error", "message" => "Opérateur invalide"], 400);
}

$reference = isset($data["reference"]) && is_string($data["reference"]) ? trim($data["reference"]) : "";
if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9._ -]*$/', $reference)) {
    json_response(["status" => "error", "message" =>
        "Référence invalide : lettres, chiffres, point, tiret uniquement"], 400);
}
// Forme enregistrée : majuscules, sans espaces ("mp 240101" et "MP240101" = même référence)
$reference = strtoupper(preg_replace('/\s+/', "", $reference));
if (strlen($reference) < $cfg["reference_min"] || strlen($reference) > $cfg["reference_max"]) {
    json_response(["status" => "error", "message" =>
        "La référence doit contenir " . $cfg["reference_min"] . " à " . $cfg["reference_max"]
        . " caractères (identifiant reçu par SMS après le paiement)"], 400);
}

// ── 2. Contrôles + insertion dans UNE transaction ────────────────
$conn = db_connect();

// Verrou nommé sur (opérateur + référence) : sans lui, deux CHAUFFEURS différents qui envoient
// la même référence à la même seconde passeraient tous les deux le contrôle de doublon
// (le verrou de ligne ci-dessous ne protège que les envois d'un même chauffeur).
// GET_LOCK attend 3 s au plus ; le verrou est libéré tout seul à la fermeture de la connexion
// (fin du script). S'il est indisponible, on continue : le contrôle de doublon reste actif.
$lockName = "taxigo_recharge_" . md5($operator . "|" . $reference);
try {
    // $lockName = "taxigo_recharge_" + 32 caractères hexadécimaux : rien à échapper
    $conn->query("SELECT GET_LOCK('" . $lockName . "', 3)");
} catch (Throwable $e) {
    error_log("[request_recharge] GET_LOCK indisponible : " . $e->getMessage());
}

$conn->begin_transaction();
try {
    // Verrou : les demandes d'un même chauffeur passent l'une après l'autre.
    $lock = $conn->prepare("SELECT name FROM chauffeur WHERE id = ? FOR UPDATE");
    $lock->bind_param("i", $driverId);
    $lock->execute();
    $driver = $lock->get_result()->fetch_assoc();
    $lock->close();
    if (!$driver) {
        $conn->rollback();
        $conn->close();
        json_response(["status" => "error", "message" => "Compte introuvable"], 404);
    }

    // Plafond de demandes en attente
    $cnt = $conn->prepare("SELECT COUNT(*) AS n FROM wallet_transactions
                           WHERE chauffeur_id = ? AND type = 'recharge' AND status = 'pending'");
    $cnt->bind_param("i", $driverId);
    $cnt->execute();
    $pending = (int) $cnt->get_result()->fetch_assoc()["n"];
    $cnt->close();
    if ($pending >= $cfg["max_pending"]) {
        $conn->rollback();
        $conn->close();
        json_response(["status" => "error", "message" =>
            "Vous avez déjà " . $pending . " demandes en attente. Attendez leur validation avant d'en envoyer une autre."], 429);
    }

    // Référence déjà utilisée (par n'importe quel chauffeur). Comparaison tolérante
    // pour les anciennes lignes (minuscules / espaces) : UPPER + sans espaces.
    $dup = $conn->prepare("SELECT id FROM wallet_transactions
                           WHERE type = 'recharge' AND operator = ?
                             AND status IN ('pending', 'completed')
                             AND UPPER(REPLACE(reference, ' ', '')) = ?
                           LIMIT 1");
    $dup->bind_param("ss", $operator, $reference);
    $dup->execute();
    $isDup = (bool) $dup->get_result()->fetch_assoc();
    $dup->close();
    if ($isDup) {
        $conn->rollback();
        $conn->close();
        // Message volontairement neutre : ne dit pas à QUI appartient la référence.
        json_response(["status" => "error", "message" =>
            "Cette référence de transaction a déjà été utilisée. Vérifiez le SMS de confirmation."], 409);
    }

    $description = "Recharge demandée";
    $ins = $conn->prepare("INSERT INTO wallet_transactions
            (chauffeur_id, type, amount_fcfa, status, operator, reference, description)
            VALUES (?, 'recharge', ?, 'pending', ?, ?, ?)");
    $ins->bind_param("iisss", $driverId, $amount, $operator, $reference, $description);
    $ins->execute();
    $id = $ins->insert_id;
    $ins->close();

    $conn->commit();
} catch (Throwable $e) {
    $conn->rollback();
    $conn->close();
    error_log("[request_recharge] " . $e->getMessage());   // détail dans le journal, pas dans la réponse
    json_response(["status" => "error", "message" => "Erreur lors de l'enregistrement de la demande"], 500);
}

// ── 3. Alerte admin (best-effort : n'échoue jamais la demande) ───
try {
    send_push_to_all_admins(
        $conn,
        "Nouvelle recharge en attente",
        $driver["name"] . " demande une recharge de " . $amount . " FCFA.",
        ["link" => "/admin/#wallets"]
    );
} catch (Throwable $e) {
    error_log("[request_recharge] push admin : " . $e->getMessage());
}
$conn->close();

json_response([
    "status" => "success",
    "message" => "Demande de recharge enregistrée",
    "transaction_id" => $id,
]);
?>
