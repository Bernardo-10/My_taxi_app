-- Migration: ajouter la colonne `incomplete` sur `chauffeur` et initialiser
-- Usage : faire un backup avant d'exécuter. Exemple :
-- mysqldump -u user -p database chauffeur > chauffeur_backup.sql
-- mysql -u user -p database < database/migrations/20260826_add_chauffeur_incomplete.sql

START TRANSACTION;

-- 1) Ajouter la colonne (idempotent si déjà ajoutée)
ALTER TABLE chauffeur
  ADD COLUMN IF NOT EXISTS `incomplete` TINYINT(1) NOT NULL DEFAULT 0;

-- 2) Marquer comme incomplete les chauffeurs en `pending` qui n'ont
-- pas tous les champs/document requis (cni, carte grise, permit,
-- capacity, license). La condition ci‑dessous considère qu'un champ
-- vide ou NULL signifie manquant.
UPDATE chauffeur SET incomplete = 1
WHERE kyc_status = 'pending' AND (
  COALESCE(NULLIF(cni_number, ''), '') = '' OR COALESCE(NULLIF(cni_expiration, ''), '') = '' OR COALESCE(NULLIF(cni_photo_recto, ''), '') = '' OR COALESCE(NULLIF(cni_photo_verso, ''), '') = ''
  OR COALESCE(NULLIF(carte_grise_immat, ''), '') = '' OR COALESCE(NULLIF(carte_grise_expiration, ''), '') = '' OR COALESCE(NULLIF(carte_grise_photo, ''), '') = ''
  OR COALESCE(NULLIF(permit_number, ''), '') = '' OR COALESCE(NULLIF(permit_expiration, ''), '') = '' OR COALESCE(NULLIF(permit_photo_recto, ''), '') = '' OR COALESCE(NULLIF(permit_photo_verso, ''), '') = ''
  OR COALESCE(NULLIF(capacity_number, ''), '') = '' OR COALESCE(NULLIF(capacity_expiration, ''), '') = '' OR COALESCE(NULLIF(capacity_photo_recto, ''), '') = '' OR COALESCE(NULLIF(capacity_photo_verso, ''), '') = ''
  OR COALESCE(NULLIF(license_number, ''), '') = '' OR COALESCE(NULLIF(license_expiration, ''), '') = '' OR COALESCE(NULLIF(license_photo_recto, ''), '') = '' OR COALESCE(NULLIF(license_photo_verso, ''), '') = ''
);

COMMIT;

-- Note : pour un comportement plus fin (ex. marquer incomplete seulement
-- si un NOMBRE MINIMUM de champs manquent), adaptez la clause WHERE ci‑dessous
-- (par ex. COUNT(IF(field='',1,NULL)) >= 3). Tester sur un clone avant prod.
