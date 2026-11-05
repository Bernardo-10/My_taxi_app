<?php
require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$data   = json_decode(file_get_contents("php://input"), true);
$type   = $data["type"]   ?? "";   // "client" | "chauffeur"
$id     = isset($data["id"]) ? (int)$data["id"] : 0;
$status = $data["status"] ?? "";   // "active" | "disabled"

if (!in_array($type, ["client", "chauffeur"])) {
    json_response(["status" => "error", "message" => "Type invalide"], 400);
}
if (!in_array($status, ["active", "disabled"])) {
    json_response(["status" => "error", "message" => "Statut invalide"], 400);
}
if ($id <= 0) {
    json_response(["status" => "error", "message" => "ID invalide"], 400);
}

$conn  = db_connect();
$table = $type === "client" ? "client" : "chauffeur";

// Quand l'admin désactive un chauffeur, le mettre automatiquement hors ligne
if ($type === "chauffeur" && $status === "disabled") {
    $stmt = $conn->prepare("UPDATE chauffeur SET status = ?, is_online = 0 WHERE id = ?");
    $stmt->bind_param("si", $status, $id);
} else {
    $stmt = $conn->prepare("UPDATE `$table` SET status = ? WHERE id = ?");
    $stmt->bind_param("si", $status, $id);
}

$stmt->execute();
$ok = $stmt->affected_rows > 0;
$stmt->close();

// S-A (S1) : un compte désactivé perd AUSSITÔT sa session (et son jeton de secours).
// Sans cela, la session déjà ouverte continuait de fonctionner jusqu'à son expiration.
// Seule la session mémorisée à la dernière connexion est connue ; les autres sessions
// éventuelles du chauffeur sont coupées par le contrôle de statut de require_driver_id()
// (au plus 30 s). La table du compte est choisie par la liste blanche ci-dessus.
if ($status === "disabled") {
    try {
        $tokStmt = $conn->prepare("SELECT session_token FROM `$table` WHERE id = ?");
        $tokStmt->bind_param("i", $id);
        $tokStmt->execute();
        $tokRow = $tokStmt->get_result()->fetch_assoc();
        $tokStmt->close();
        if ($tokRow && !empty($tokRow["session_token"])) {
            $delStmt = $conn->prepare("DELETE FROM sessions WHERE id = ?");
            $delStmt->bind_param("s", $tokRow["session_token"]);
            $delStmt->execute();
            $delStmt->close();
        }
        $clrStmt = $conn->prepare("UPDATE `$table` SET session_token = NULL WHERE id = ?");
        $clrStmt->bind_param("i", $id);
        $clrStmt->execute();
        $clrStmt->close();
    } catch (Throwable $e) {
        error_log("[set_user_status] coupure de session impossible : " . $e->getMessage());
    }
}
$conn->close();

json_response([
    "status"  => $ok ? "success" : "error",
    "message" => $ok ? "Statut mis a jour" : "Utilisateur introuvable"
]);
?>
