<?php
require_once __DIR__ . "/../config/auth.php";

$data = json_decode(file_get_contents("php://input"), true);

if (!$data) {
    json_response(["status" => "error", "message" => "Aucune donnee recue"], 400);
}

$name = trim($data["name"] ?? "");
$phone = trim($data["phone"] ?? "");
$email = trim($data["email"] ?? "");
$password = $data["password"] ?? "";
$plate = trim($data["plate"] ?? "");
$carBrand = trim($data["car_brand"] ?? "");
$carColor = trim($data["car_color"] ?? "");

if ($name === "" || $phone === "" || $email === "" || $password === "" || $plate === "") {
    json_response(["status" => "error", "message" => "Nom, telephone, email, plaque et mot de passe requis"], 400);
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    json_response(["status" => "error", "message" => "Email invalide"], 400);
}

if (strlen($password) < 6) {
    json_response(["status" => "error", "message" => "Le mot de passe doit contenir au moins 6 caracteres"], 400);
}

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
$stmt = $conn->prepare("
    INSERT INTO chauffeur (name, phone, email, password_hash, plate, car_brand, car_color, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
");
$stmt->bind_param("sssssss", $name, $phone, $email, $passwordHash, $plate, $carBrand, $carColor);

if (!$stmt->execute()) {
    $stmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Inscription impossible"], 500);
}

$driverId = $conn->insert_id;
$stmt->close();

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
    "message" => "Compte chauffeur cree",
    "session_token" => $sessionToken,
    "driver" => [
        "id" => (int) $driverId,
        "name" => $name,
        "email" => $email,
        "phone" => $phone,
        "plate" => $plate,
        "car_brand" => $carBrand,
        "car_color" => $carColor
    ]
]);
?>

