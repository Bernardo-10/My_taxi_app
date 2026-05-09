<?php
require_once __DIR__ . "/../config/auth.php";

$data = json_decode(file_get_contents("php://input"), true);

if (!$data) {
    json_response(["status" => "error", "message" => "Aucune donnee recue"], 400);
}

$login = trim($data["login"] ?? $data["email"] ?? $data["phone"] ?? "");
$password = $data["password"] ?? "";

if ($login === "" || $password === "") {
    json_response(["status" => "error", "message" => "Identifiant et mot de passe requis"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("
    SELECT id, name, email, phone, plate, car_brand, car_color, password_hash, status
    FROM chauffeur
    WHERE email = ? OR phone = ? OR plate = ?
    LIMIT 1
");
$stmt->bind_param("sss", $login, $login, $login);
$stmt->execute();
$result = $stmt->get_result();
$driver = $result->fetch_assoc();
$stmt->close();

if (!$driver || $driver["status"] !== "active" || !password_verify($password, $driver["password_hash"])) {
    $conn->close();
    json_response(["status" => "error", "message" => "Identifiants invalides"], 401);
}

session_regenerate_id(true);
refresh_session_cookie();
$_SESSION["role"] = "chauffeur";
$_SESSION["driver_id"] = (int) $driver["id"];
$_SESSION["driver_name"] = $driver["name"];
unset($_SESSION["client_id"], $_SESSION["client_name"]);

$sessionToken = store_session_token($conn, "chauffeur", (int) $driver["id"]);
$conn->close();

json_response([
    "status" => "success",
    "message" => "Chauffeur connecte",
    "session_token" => $sessionToken,
    "driver" => [
        "id" => (int) $driver["id"],
        "name" => $driver["name"],
        "email" => $driver["email"],
        "phone" => $driver["phone"],
        "plate" => $driver["plate"],
        "car_brand" => $driver["car_brand"],
        "car_color" => $driver["car_color"]
    ]
]);
?>

