<?php
// Sert les documents chauffeur (photos CNI, carte grise, permis, capacité,
// licence) uniquement à un admin authentifié. Le dossier backend/uploads/
// est bloqué par .htaccess (Require all denied) : c'est le SEUL chemin
// légitime pour consulter ces fichiers.

require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$relativePath = $_GET["path"] ?? "";

// Le chemin attendu est toujours "chauffeur_docs/{id}/{fichier}" — on le
// valide strictement avant de construire un chemin disque, pour empêcher
// toute tentative de traversée de répertoire (../, chemins absolus, etc.)
if (!preg_match('#^chauffeur_docs/\d+/[a-zA-Z0-9_\-]+\.(jpg|jpeg|png|webp)$#', $relativePath)) {
    http_response_code(400);
    exit("Chemin invalide");
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
header("Cache-Control: private, max-age=300"); // léger cache, reste privé
header("X-Content-Type-Options: nosniff");
readfile($fullPath);
exit;
?>
