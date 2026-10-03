-- Migration : validation KYC initiale par document (au lieu d'un seul
-- statut global pour tout le dossier).
--
-- IMPORTANT : cette table ne concerne QUE l'examen initial (première
-- soumission, kyc_status encore 'incomplete' au départ). Elle est
-- totalement indépendante de `chauffeur_document_renewals` (renouvellement
-- d'un document déjà approuvé) — les deux systèmes ne se touchent jamais,
-- volontairement, pour ne pas faire repasser un chauffeur déjà approuvé en
-- attente pendant l'examen d'un renouvellement.

CREATE TABLE IF NOT EXISTS chauffeur_document_reviews (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    chauffeur_id INT UNSIGNED NOT NULL,
    document_group ENUM('cni', 'carte_grise', 'permit', 'capacity', 'license') NOT NULL,
    status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
    rejection_reason TEXT NULL,
    reviewed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_chauffeur_document (chauffeur_id, document_group),
    CONSTRAINT fk_cdr_chauffeur FOREIGN KEY (chauffeur_id) REFERENCES chauffeur(id) ON DELETE CASCADE
);

-- ── Backfill des dossiers déjà existants ──────────────────────────
-- Ne concerne que les chauffeurs qui ont déjà dépassé 'incomplete'
-- (kyc_status IN ('pending','approved','rejected')) et qui n'ont pas
-- encore de lignes ici. Reconstruit 5 lignes cohérentes avec le statut
-- global actuel :
--   - 'approved' -> les 5 documents 'approved'
--   - 'pending'  -> les 5 documents 'pending' (on ne peut pas savoir
--                   rétroactivement si un examen partiel avait eu lieu ;
--                   ce cas n'existait pas avant ce chantier)
--   - 'rejected' -> les 5 documents 'rejected', avec le même
--                   kyc_rejection_reason partagé sur les 5 (limite connue :
--                   l'ancien système n'avait qu'un seul motif pour tout le
--                   dossier, on ne peut pas reconstituer lequel des 5
--                   documents posait problème à l'époque)
INSERT INTO chauffeur_document_reviews (chauffeur_id, document_group, status, rejection_reason, reviewed_at)
SELECT c.id, g.document_group,
       CASE c.kyc_status
           WHEN 'approved' THEN 'approved'
           WHEN 'rejected' THEN 'rejected'
           ELSE 'pending'
       END,
       CASE WHEN c.kyc_status = 'rejected' THEN c.kyc_rejection_reason ELSE NULL END,
       CASE WHEN c.kyc_status IN ('approved', 'rejected') THEN c.kyc_reviewed_at ELSE NULL END
FROM chauffeur c
CROSS JOIN (
    SELECT 'cni' AS document_group
    UNION ALL SELECT 'carte_grise'
    UNION ALL SELECT 'permit'
    UNION ALL SELECT 'capacity'
    UNION ALL SELECT 'license'
) g
WHERE c.kyc_status IN ('pending', 'approved', 'rejected')
  AND NOT EXISTS (
      SELECT 1 FROM chauffeur_document_reviews r
      WHERE r.chauffeur_id = c.id AND r.document_group = g.document_group
  );
