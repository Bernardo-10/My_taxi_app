<?php
require_once __DIR__ . "/../config/auth.php";
error_log("=== CURRENT_USER SESSION === ID: " . session_id());
error_log("=== CURRENT_USER SESSION === role: " . ($_SESSION['role'] ?? 'vide'));
error_log("=== CURRENT_USER SESSION === client_id: " . ($_SESSION['client_id'] ?? 'vide'));
error_log("=== CURRENT_USER COOKIE === " . ($_COOKIE[session_name()] ?? 'absent'));

// Fallback : si session vide, tenter via session_token en BD
if (empty($_SESSION["role"])) {
    $cookieToken = $_COOKIE[session_name()] ?? "";
    if ($cookieToken) {
        $conn = db_connect();

        // Chercher dans table client
        $stmt = $conn->prepare("SELECT id FROM client WHERE session_token = ? AND status = 'active' LIMIT 1");
        $stmt->bind_param("s", $cookieToken);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();

        if ($row) {
            $_SESSION["role"] = "client";
            $_SESSION["client_id"] = (int) $row["id"];
        } else {
            // Chercher dans table chauffeur
            $stmt = $conn->prepare("SELECT id FROM chauffeur WHERE session_token = ? AND status = 'active' LIMIT 1");
            $stmt->bind_param("s", $cookieToken);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            $stmt->close();

            if ($row) {
                $_SESSION["role"] = "chauffeur";
                $_SESSION["driver_id"] = (int) $row["id"];
            }
        }
        $conn->close();
    }
}

$role = $_SESSION["role"] ?? "";
$user = null;
$conn = db_connect();

if ($role === "client" && !empty($_SESSION["client_id"])) {
    $id = (int) $_SESSION["client_id"];
    $stmt = $conn->prepare("
        SELECT id, full_name AS name, email, phone, car_brand, car_color, status
        FROM client WHERE id = ? LIMIT 1
    ");
    $stmt->bind_param("i", $id);
    $stmt->execute();
    $user = $stmt->get_result()->fetch_assoc();
    $stmt->close();
} elseif ($role === "chauffeur" && !empty($_SESSION["driver_id"])) {
    $id = (int) $_SESSION["driver_id"];
    $stmt = $conn->prepare("
        SELECT id, name, email, phone, plate, car_brand, car_color, status, is_online
        FROM chauffeur WHERE id = ? LIMIT 1
    ");
    $stmt->bind_param("i", $id);
    $stmt->execute();
    $user = $stmt->get_result()->fetch_assoc();
    $stmt->close();
} else {
    $conn->close();
    json_response([
        "status"      => "error",
        "message"     => "Utilisateur non connecte",
        "session_id"  => session_id(),
        "session"     => $_SESSION,
        "cookie"      => $_COOKIE[session_name()] ?? "absent",
        "all_cookies" => $_COOKIE
    ], 401);
}

$conn->close();

if (!$user) {
    json_response(["status" => "error", "message" => "Utilisateur introuvable"], 404);
}

$user["id"] = (int) $user["id"];
$user["role"] = $role;

json_response(["status" => "success", "user" => $user]);
?>