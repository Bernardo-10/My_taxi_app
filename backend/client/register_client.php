<?php
require_once __DIR__ . "/../config/auth.php";

$data = json_decode(file_get_contents("php://input"), true);

if (!$data) {
    json_response(["status" => "error", "message" => "Aucune donnee recue"], 400);
}

$fullName = trim($data["full_name"] ?? "");
$phone = trim($data["phone"] ?? "");
$email = trim($data["email"] ?? "");
$password = $data["password"] ?? "";
$carBrand = trim($data["car_brand"] ?? "");
$carColor = trim($data["car_color"] ?? "");

if ($fullName === "" || $phone === "" || $email === "" || $password === "") {
    json_response(["status" => "error", "message" => "Nom, telephone, email et mot de passe requis"], 400);
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    json_response(["status" => "error", "message" => "Email invalide"], 400);
}

if (strlen($password) < 6) {
    json_response(["status" => "error", "message" => "Le mot de passe doit contenir au moins 6 caracteres"], 400);
}

$conn = db_connect();

$checkStmt = $conn->prepare("SELECT id FROM client WHERE email = ? OR phone = ? LIMIT 1");
$checkStmt->bind_param("ss", $email, $phone);
$checkStmt->execute();
$exists = $checkStmt->get_result()->num_rows > 0;
$checkStmt->close();

if ($exists) {
    $conn->close();
    json_response(["status" => "error", "message" => "Un client existe deja avec cet email ou ce telephone"], 409);
}

$passwordHash = password_hash($password, PASSWORD_DEFAULT);
$stmt = $conn->prepare("
    INSERT INTO client (full_name, phone, email, password_hash, car_brand, car_color, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
");
$stmt->bind_param("ssssss", $fullName, $phone, $email, $passwordHash, $carBrand, $carColor);

if (!$stmt->execute()) {
    $stmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Inscription impossible"], 500);
}

$clientId = $conn->insert_id;
$stmt->close();

session_regenerate_id(true);
refresh_session_cookie();
$_SESSION["role"] = "client";
$_SESSION["client_id"] = (int) $clientId;
$_SESSION["client_name"] = $fullName;
unset($_SESSION["driver_id"], $_SESSION["driver_name"]);

$sessionToken = store_session_token($conn, "client", (int) $clientId);
$conn->close();

json_response([
    "status" => "success",
    "message" => "Compte client cree",
    "session_token" => $sessionToken,
    "client" => [
        "id" => (int) $clientId,
        "name" => $fullName,
        "email" => $email,
        "phone" => $phone
    ]
]);
?>

