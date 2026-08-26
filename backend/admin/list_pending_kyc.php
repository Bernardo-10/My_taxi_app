<?php
require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$conn = db_connect();

// Filtre optionnel ?status=pending|approved|rejected — par défaut,
// on renvoie tout pour laisser l'admin filtrer côté frontend, mais
// ?status=pending est le cas d'usage principal (file d'attente).
$statusFilter = isset($_GET["status"]) ? trim($_GET["status"]) : "";

$sql = "
    SELECT
        id, name, email, phone, plate, car_brand, car_color,
        kyc_status, kyc_rejection_reason, kyc_reviewed_at, created_at,

        cni_number, cni_expiration, cni_photo_recto, cni_photo_verso,
        carte_grise_immat, carte_grise_expiration, carte_grise_photo,
        permit_number, permit_expiration, permit_photo_recto, permit_photo_verso,
        capacity_number, capacity_expiration, capacity_photo_recto, capacity_photo_verso,
        license_number, license_expiration, license_photo_recto, license_photo_verso
    FROM chauffeur
";

$params = [];
$types = "";
if (in_array($statusFilter, ["pending", "approved", "rejected", "incomplete"])) {
    $sql .= " WHERE kyc_status = ?";
    $params[] = $statusFilter;
    $types .= "s";
}

// File d'attente : les dossiers réellement soumis et en attente
// ('pending') remontent en priorité — ce sont ceux qui attendent une
// action admin. Les dossiers 'incomplete' (inscription non finalisée par
// le chauffeur lui-même) ne bloquent personne d'autre, donc triés après,
// mais toujours avant approved/rejected qui n'ont plus besoin d'attention.
$sql .= " ORDER BY FIELD(kyc_status, 'pending', 'incomplete', 'rejected', 'approved'), created_at ASC";

$stmt = $conn->prepare($sql);
if ($params) {
    $stmt->bind_param($types, ...$params);
}
$stmt->execute();
$result = $stmt->get_result();

$chauffeurs = [];
while ($row = $result->fetch_assoc()) {
    $row["id"] = (int) $row["id"];

    // Chemins relatifs transformés en URL de consultation (protégées,
    // require_admin_id() à l'intérieur de serve_document.php) plutôt
    // que le chemin brut — le frontend n'a jamais besoin de connaître
    // la structure réelle du dossier uploads/.
    $docFields = [
        "cni_photo_recto", "cni_photo_verso",
        "carte_grise_photo",
        "permit_photo_recto", "permit_photo_verso",
        "capacity_photo_recto", "capacity_photo_verso",
        "license_photo_recto", "license_photo_verso"
    ];
    foreach ($docFields as $field) {
        if (!empty($row[$field])) {
            $row[$field . "_url"] = "/backend/admin/serve_document.php?path=" . rawurlencode($row[$field]);
        } else {
            $row[$field . "_url"] = null;
        }
    }

    $chauffeurs[] = $row;
}

$stmt->close();
$conn->close();
json_response(["status" => "success", "chauffeurs" => $chauffeurs]);
?>