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
if (in_array($statusFilter, ["pending", "approved", "rejected"])) {
    $sql .= " WHERE kyc_status = ?";
    $params[] = $statusFilter;
    $types .= "s";
}

// File d'attente : les plus anciens en attente remontent en premier
// (c'est ceux qui attendent depuis le plus longtemps qu'il faut traiter
// en priorité), les autres statuts triés par date de revue récente.
$sql .= " ORDER BY (kyc_status = 'pending') DESC, created_at ASC";

$stmt = $conn->prepare($sql);
if ($params) {
    $stmt->bind_param($types, ...$params);
}
$stmt->execute();
$result = $stmt->get_result();

// ── Renouvellements en cours, pour tous les chauffeurs en une seule
// requête (évite le N+1) — seuls 'pending'/'rejected' comptent, un
// renouvellement 'approved' a déjà été copié dans les colonnes live
// et n'a plus besoin d'être signalé à l'admin. Seule la ligne la plus
// récente par (chauffeur, document_group) est retenue, au cas où
// plusieurs resoumissions se seraient accumulées dans l'historique.
$renewalsByChauffeur = [];
$renewalResult = $conn->query("
    SELECT id, chauffeur_id, document_group, number, expiration,
           photo_recto, photo_verso, status, rejection_reason, submitted_at
    FROM chauffeur_document_renewals
    WHERE status IN ('pending', 'rejected')
    ORDER BY submitted_at DESC
");
while ($r = $renewalResult->fetch_assoc()) {
    $cid = (int) $r["chauffeur_id"];
    $renewalsByChauffeur[$cid] = $renewalsByChauffeur[$cid] ?? [];

    // Une seule entrée par document_group pour ce chauffeur (la plus
    // récente, grâce au ORDER BY submitted_at DESC ci-dessus).
    $alreadyHasGroup = false;
    foreach ($renewalsByChauffeur[$cid] as $existing) {
        if ($existing["document_group"] === $r["document_group"]) { $alreadyHasGroup = true; break; }
    }
    if ($alreadyHasGroup) continue;

    $renewalsByChauffeur[$cid][] = [
        "id" => (int) $r["id"],
        "document_group" => $r["document_group"],
        "number" => $r["number"],
        "expiration" => $r["expiration"],
        "photo_recto_url" => !empty($r["photo_recto"]) ? "/backend/admin/serve_document.php?path=" . rawurlencode($r["photo_recto"]) : null,
        "photo_verso_url" => !empty($r["photo_verso"]) ? "/backend/admin/serve_document.php?path=" . rawurlencode($r["photo_verso"]) : null,
        "status" => $r["status"],
        "rejection_reason" => $r["rejection_reason"],
        "submitted_at" => $r["submitted_at"]
    ];
}

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

    $row["pending_renewals"] = $renewalsByChauffeur[$row["id"]] ?? [];

    $chauffeurs[] = $row;
}

$stmt->close();
$conn->close();
json_response(["status" => "success", "chauffeurs" => $chauffeurs]);
?>
