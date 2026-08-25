<?php
// Sert les documents (photos CNI, carte grise, permis, capacité, licence)
// UNIQUEMENT au chauffeur propriétaire, authentifié. Miroir exact de
// backend/admin/serve_document.php, avec une vérification supplémentaire :
// l'ID du chauffeur contenu dans le chemin doit correspondre à la
// session en cours (un chauffeur ne doit jamais pouvoir consulter les
// documents d'un autre en devinant un chemin).

require_once __DIR__ . "/../config/auth.php";
$driverId = require_driver_id();

$relativePath = $_GET["path"] ?? "";

// Même validation stricte que côté admin : empêche toute tentative de
// traversée de répertoire (../, chemins absolus, etc.)
if (!preg_match('#^chauffeur_docs/(\d+)/[a-zA-Z0-9_\-]+\.(jpg|jpeg|png|webp)$#', $relativePath, $matches)) {
    http_response_code(400);
    exit("Chemin invalide");
}

// Vérification de propriété : le dossier chauffeur_docs/{id}/ dans le
// chemin doit correspondre au chauffeur connecté.
$pathOwnerId = (int) $matches[1];
if ($pathOwnerId !== $driverId) {
    http_response_code(403);
    exit("Acces refuse");
}

$uploadRoot = realpath(__DIR__ . "/../uploads");
$fullPath = realpath($uploadRoot . "/" . $relativePath);

// Double vérification : le chemin résolu doit rester strictement à
// l'intérieur du dossier uploads/ (protège aussi contre les liens
// symboliques malicieux).
if ($fullPath === false || strpos($fullPath, $uploadRoot) !== 0 || !is_file($fullPath)) {
    http_response_code(404);
    exit("Document introuvable");
}

$mimeTypes = [
    "jpg" => "image/jpeg", "jpeg" => "image/jpeg",
    "png" => "image/png", "webp" => "image/webp"
];
$ext = strtolower(pathinfo($fullPath, PATHINFO_EXTENSION));
$mime = $mimeTypes[$ext] ?? "application/octet-stream";

header("Content-Type: " . $mime);
header("Content-Length: " . filesize($fullPath));
header("Cache-Control: private, max-age=300");
header("X-Content-Type-Options: nosniff");
readfile($fullPath);
exit;
?>
