<?php
// Renvoie, pour le chauffeur connecté, l'état de ses 5 groupes de
// documents KYC : les valeurs "live" (celles qui comptent pour le
// blocage à la mise en ligne), le nombre de jours avant expiration,
// et — s'il y en a un — l'état du renouvellement en cours pour ce
// document précis (chauffeur_document_renewals).
//
// Alimente le tiroir "Mes documents" (frontend/chauffeur/js/chauffeur-ui.js,
// fetchMyDocuments()) et le badge d'alerte discret sur le bouton du
// profil (voir rapport-kyc-chauffeur.md, §2 et §3).

require_once __DIR__ . "/../config/auth.php";
$driverId = require_driver_id();

$conn = db_connect();

// ── 1. Documents live ────────────────────────────────────────────
$stmt = $conn->prepare("
    SELECT
        cni_number, cni_expiration, cni_photo_recto, cni_photo_verso,
        carte_grise_immat, carte_grise_expiration, carte_grise_photo,
        permit_number, permit_expiration, permit_photo_recto, permit_photo_verso,
        capacity_number, capacity_expiration, capacity_photo_recto, capacity_photo_verso,
        license_number, license_expiration, license_photo_recto, license_photo_verso
    FROM chauffeur WHERE id = ? LIMIT 1
");
$stmt->bind_param("i", $driverId);
$stmt->execute();
$row = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$row) {
    $conn->close();
    json_response(["status" => "error", "message" => "Chauffeur introuvable"], 404);
}

// Chemins relatifs -> URLs protégées (serve_document.php côté chauffeur,
// vérifie que le document appartient bien à la session en cours).
function doc_url(?string $relativePath): ?string {
    if (empty($relativePath)) return null;
    return "/backend/chauffeur/serve_document.php?path=" . rawurlencode($relativePath);
}

// Jours restants avant expiration (peut être négatif si déjà expiré) —
// calcul à la demande, pas de valeur stockée à rafraîchir (cf. rapport
// §4, principe de l'expiration paresseuse déjà utilisé ailleurs dans
// le projet, pas de cron disponible sur InfinityFree).
function days_until(?string $expiration): ?int {
    if (empty($expiration)) return null;
    $today = new DateTime("today");
    $expDate = new DateTime($expiration);
    return (int) $today->diff($expDate)->format("%r%a");
}

// Mapping colonne(s) live par groupe de document — la carte grise n'a
// qu'une seule photo, contrairement aux 4 autres groupes.
$liveMap = [
    "cni" => [
        "number" => $row["cni_number"], "expiration" => $row["cni_expiration"],
        "photo_recto" => doc_url($row["cni_photo_recto"]), "photo_verso" => doc_url($row["cni_photo_verso"])
    ],
    "carte_grise" => [
        "number" => $row["carte_grise_immat"], "expiration" => $row["carte_grise_expiration"],
        "photo_recto" => doc_url($row["carte_grise_photo"]), "photo_verso" => null
    ],
    "permit" => [
        "number" => $row["permit_number"], "expiration" => $row["permit_expiration"],
        "photo_recto" => doc_url($row["permit_photo_recto"]), "photo_verso" => doc_url($row["permit_photo_verso"])
    ],
    "capacity" => [
        "number" => $row["capacity_number"], "expiration" => $row["capacity_expiration"],
        "photo_recto" => doc_url($row["capacity_photo_recto"]), "photo_verso" => doc_url($row["capacity_photo_verso"])
    ],
    "license" => [
        "number" => $row["license_number"], "expiration" => $row["license_expiration"],
        "photo_recto" => doc_url($row["license_photo_recto"]), "photo_verso" => doc_url($row["license_photo_verso"])
    ]
];

// ── 2. Renouvellements en cours (pending/rejected uniquement) ────
// Un renouvellement "approved" a déjà été copié dans les colonnes live
// ci-dessus — on ne le renvoie plus une fois traité, il ne reste que
// pour l'historique en base. Seule la dernière ligne par document_group
// compte (au cas où plusieurs resoumissions se seraient accumulées).
$renewalStmt = $conn->prepare("
    SELECT document_group, status, number, expiration, rejection_reason, submitted_at
    FROM chauffeur_document_renewals
    WHERE chauffeur_id = ? AND status IN ('pending', 'rejected')
    ORDER BY submitted_at DESC
");
$renewalStmt->bind_param("i", $driverId);
$renewalStmt->execute();
$renewalResult = $renewalStmt->get_result();

$renewalsByGroup = [];
while ($r = $renewalResult->fetch_assoc()) {
    // La première ligne rencontrée par groupe est la plus récente
    // (grâce au ORDER BY submitted_at DESC) — on ignore les suivantes.
    if (!isset($renewalsByGroup[$r["document_group"]])) {
        $renewalsByGroup[$r["document_group"]] = [
            "status" => $r["status"],
            "number" => $r["number"],
            "expiration" => $r["expiration"],
            "rejection_reason" => $r["rejection_reason"],
            "submitted_at" => $r["submitted_at"]
        ];
    }
}
$renewalStmt->close();

// ── 3. Assemblage final ──────────────────────────────────────────
$documents = [];
foreach ($liveMap as $group => $live) {
    $documents[$group] = [
        "number" => $live["number"],
        "expiration" => $live["expiration"],
        "photo_recto" => $live["photo_recto"],
        "photo_verso" => $live["photo_verso"],
        "days_until_expiration" => days_until($live["expiration"]),
        "pending" => $renewalsByGroup[$group] ?? null
    ];
}

$conn->close();
json_response(["status" => "success", "documents" => $documents]);
?>
