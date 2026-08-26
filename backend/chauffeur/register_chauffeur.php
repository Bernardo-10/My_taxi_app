<?php
require_once __DIR__ . "/../config/auth.php";

// ── Inscription allégée (voir rapport friction-inscription-chauffeur.md) ──
// Avant : ce fichier exigeait les 5 documents KYC (10 champs texte + 9
// photos) dès l'inscription — un formulaire de 6 étapes avant même de
// voir l'application. Le chauffeur ne pouvait pas savoir "ce qu'il y a
// derrière" avant de s'être engagé dans tout ce travail.
//
// Maintenant : seuls les champs strictement nécessaires à la création
// d'un compte (identité, mot de passe, véhicule) sont demandés ici. Le
// compte est créé avec kyc_status = 'incomplete' (nouveau statut, à
// ajouter à l'ENUM en base — voir rapport). La complétion des documents
// se fait ensuite, connecté, via complete_chauffeur_profile.php — le
// chauffeur voit le tableau de bord avant de s'engager dans les documents.
//
// set_driver_status.php bloque toujours la mise en ligne tant que
// kyc_status !== 'approved' (ce comportement existait déjà et n'a pas
// changé) : l'exigence documentaire n'est pas retirée, seulement déplacée
// après la création du compte.

// Le formulaire envoie un FormData (compatibilité avec l'ancien flux),
// donc on lit $_POST comme avant.
$name = trim($_POST["name"] ?? "");
$phone = trim($_POST["phone"] ?? "");
$email = trim($_POST["email"] ?? "");
$password = $_POST["password"] ?? "";
$passwordConfirm = $_POST["password_confirm"] ?? "";
$plate = trim($_POST["plate"] ?? "");
$carBrand = trim($_POST["car_brand"] ?? "");
$carColor = trim($_POST["car_color"] ?? "");

if ($name === "" || $phone === "" || $email === "" || $password === "" || $plate === "") {
    json_response(["status" => "error", "message" => "Nom, telephone, email, plaque et mot de passe requis"], 400);
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    json_response(["status" => "error", "message" => "Email invalide"], 400);
}

if (strlen($password) < 6) {
    json_response(["status" => "error", "message" => "Le mot de passe doit contenir au moins 6 caracteres"], 400);
}

if ($password !== $passwordConfirm) {
    json_response(["status" => "error", "message" => "Les deux mots de passe ne correspondent pas"], 400);
}

// ── Compte déjà existant ? ────────────────────────────────────────
$conn = db_connect();

$checkStmt = $conn->prepare("SELECT id FROM chauffeur WHERE email = ? OR phone = ? OR plate = ? LIMIT 1");
$checkStmt->bind_param("sss", $email, $phone, $plate);
$checkStmt->execute();
$exists = $checkStmt->get_result()->num_rows > 0;
$checkStmt->close();

if ($exists) {
    $conn->close();
    json_response(["status" => "error", "message" => "Un chauffeur existe deja avec cet email, ce telephone ou cette plaque"], 409);
}

$passwordHash = password_hash($password, PASSWORD_DEFAULT);

// ── Création du compte : aucun document, kyc_status = 'incomplete' ──
// Toutes les colonnes documents (cni_number, permit_number, etc.) restent
// NULL jusqu'à la complétion du profil — c'est exactement l'état que
// get_my_documents.php et l'admin savent déjà afficher comme "manquant".
$stmt = $conn->prepare("
    INSERT INTO chauffeur (
        name, phone, email, password_hash, plate, car_brand, car_color,
        kyc_status, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'incomplete', 'active')
");
$stmt->bind_param(
    "sssssss",
    $name, $phone, $email, $passwordHash, $plate, $carBrand, $carColor
);

if (!$stmt->execute()) {
    $stmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Inscription impossible"], 500);
}

$driverId = $conn->insert_id;
$stmt->close();

// ── Session ────────────────────────────────────────────────────
session_regenerate_id(true);
refresh_session_cookie();
$_SESSION["role"] = "chauffeur";
$_SESSION["driver_id"] = (int) $driverId;
$_SESSION["driver_name"] = $name;
unset($_SESSION["client_id"], $_SESSION["client_name"]);

$sessionToken = store_session_token($conn, "chauffeur", (int) $driverId);
$conn->close();

json_response([
    "status" => "success",
    "message" => "Compte chauffeur cree. Completez votre profil pour passer en ligne.",
    "session_token" => $sessionToken,
    "driver" => [
        "id" => (int) $driverId,
        "name" => $name,
        "email" => $email,
        "phone" => $phone,
        "plate" => $plate,
        "car_brand" => $carBrand,
        "car_color" => $carColor,
        "kyc_status" => "incomplete"
    ]
]);
?>
