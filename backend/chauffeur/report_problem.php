<?php
// Signalement d'un problème par le chauffeur (lot F4).
//
// AVANT : le signalement passait la course au statut 'reported' = terminal.
// Un chauffeur mal intentionné pouvait donc se « cacher » : la course n'était
// plus suivie ni par le client ni par l'admin.
//
// MAINTENANT : la course GARDE son statut ('started') et continue d'être suivie.
// Le signalement est seulement enregistré (problem_description, problem_at) et
// l'administrateur est alerté, comme pour le signalement client (client_problem_*).
// L'admin le marque « traité » avec backend/admin/resolve_driver_problem.php.
//
// Prérequis : database/migration_lot_f4.sql (colonnes problem_at et
// problem_resolved_at) à exécuter AVANT de déposer ce fichier.
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/send_push.php";

$driverId = require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);
$id = isset($data["id"]) ? (int) $data["id"] : 0;
$problem_description = (isset($data["problem"]) && is_string($data["problem"])) ? trim($data["problem"]) : "";

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

if ($problem_description === "") {
    json_response(["status" => "error", "message" => "Description du probleme requise"], 400);
}

// Borne la taille du texte (la colonne est un TEXT, mais inutile d'accepter un roman)
$problem_description = mb_substr($problem_description, 0, 1000);

try {
    $conn = db_connect();

    // On ne signale que sur une course démarrée du chauffeur connecté, et seulement
    // s'il n'y a pas déjà un signalement NON traité (sinon on écraserait le premier
    // texte). Après traitement par l'admin, le chauffeur peut signaler à nouveau :
    // problem_resolved_at repasse alors à NULL.
    $stmt = $conn->prepare("
        UPDATE rides
        SET problem_description = ?,
            problem_at = NOW(),
            problem_resolved_at = NULL
        WHERE id = ?
          AND driver_id = ?
          AND status = 'started'
          AND (problem_description IS NULL OR problem_resolved_at IS NOT NULL)
    ");
    $stmt->bind_param("sii", $problem_description, $id, $driverId);
    $stmt->execute();
    $updated = $stmt->affected_rows > 0;
    $stmt->close();

    if ($updated) {
        // Alerte push aux admins (le sondage de la page admin reste le filet de secours)
        $info = $conn->prepare("SELECT driver_name FROM rides WHERE id = ?");
        $info->bind_param("i", $id);
        $info->execute();
        $row = $info->get_result()->fetch_assoc();
        $info->close();
        $who = trim((string) ($row["driver_name"] ?? ""));

        send_push_to_all_admins(
            $conn,
            "Signalement chauffeur",
            ($who !== "" ? "$who : " : "") . "problème signalé sur la course #$id.",
            ["link" => "/admin/#rides"]
        );

        $conn->close();
        json_response(["status" => "success", "message" => "Probleme signale"]);
    }

    // Échec : on précise pourquoi (déjà signalé, ou course non démarrée)
    $why = $conn->prepare("SELECT status, problem_description, problem_resolved_at FROM rides WHERE id = ? AND driver_id = ?");
    $why->bind_param("ii", $id, $driverId);
    $why->execute();
    $ride = $why->get_result()->fetch_assoc();
    $why->close();
    $conn->close();

    if ($ride && $ride["status"] === "started" && $ride["problem_description"] !== null && $ride["problem_resolved_at"] === null) {
        json_response(["status" => "error", "message" => "Probleme deja signale : l'administrateur a ete alerte"], 409);
    }
    json_response(["status" => "error", "message" => "Impossible de signaler (course non demarree)"], 409);
} catch (Throwable $e) {
    error_log("[report_problem chauffeur] " . $e->getMessage());
    json_response(["status" => "error", "message" => "Erreur serveur"], 500);
}
?>
