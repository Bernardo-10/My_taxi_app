-- ════════════════════════════════════════════════════════════════════════
-- Lot 11 (11-A) — Téléphones des chauffeurs sous forme canonique "+237XXXXXXXXX"
--
-- Les comptes créés avant le lot 11 ont un téléphone écrit "tel que tapé"
-- ("677123456", "+237 677 123 456", "237677123456"...). Cette migration les
-- remet tous sous la forme "+237677123456", celle qu'écrit désormais
-- register_chauffeur.php.
--
-- ► CETTE MIGRATION EST FACULTATIVE pour que l'application fonctionne : le
--   nouveau login_chauffeur.php et le nouveau register_chauffeur.php retrouvent
--   déjà les anciens numéros sous toutes leurs écritures. La migration sert à
--   avoir une base propre (affichage uniforme dans l'admin, liens tel: cohérents).
--
-- À EXÉCUTER DANS phpMyAdmin (onglet SQL), ÉTAPE PAR ÉTAPE, DANS L'ORDRE.
-- Faites d'abord un export de la table `chauffeur` (sauvegarde).
-- Seuls les numéros camerounais reconnus sont modifiés (9 chiffres commençant
-- par 6 ou 2, avec ou sans 237 / 00237). Les autres lignes ne sont pas touchées.
-- ════════════════════════════════════════════════════════════════════════


-- ── ÉTAPE 1 — Chercher les DOUBLONS (lecture seule) ─────────────────────
-- Deux comptes dont les numéros sont identiques une fois normalisés.
-- ► Si cette requête renvoie des lignes : NE PASSEZ PAS à l'étape 2 (elle
--   échouerait sur l'index unique uniq_chauffeur_phone). Corrigez d'abord à la
--   main (désactivez ou modifiez l'un des comptes), puis relancez l'étape 1.
-- ► Si elle ne renvoie RIEN : passez à l'étape 2.
SELECT RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')',''), 9) AS numero_national,
       COUNT(*)                         AS nb_comptes,
       GROUP_CONCAT(id)                 AS ids,
       GROUP_CONCAT(phone SEPARATOR ' | ') AS ecritures
FROM chauffeur
WHERE phone IS NOT NULL
  AND (
        (LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')','')) = 9
         AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')','') REGEXP '^[26]')
     OR (LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')','')) = 12
         AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')','') REGEXP '^237[26]')
     OR (LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')','')) = 14
         AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')','') REGEXP '^00237[26]')
      )
GROUP BY numero_national
HAVING COUNT(*) > 1;


-- ── ÉTAPE 2 — Normaliser (modifie les données) ──────────────────────────
-- N'exécutez cette étape que si l'étape 1 n'a renvoyé aucune ligne.
UPDATE chauffeur
SET phone = CONCAT('+237', RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')',''), 9))
WHERE phone IS NOT NULL
  AND (
        (LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')','')) = 9
         AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')','') REGEXP '^[26]')
     OR (LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')','')) = 12
         AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')','') REGEXP '^237[26]')
     OR (LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')','')) = 14
         AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')','') REGEXP '^00237[26]')
      );


-- ── ÉTAPE 3 — Vérifier (lecture seule) ──────────────────────────────────
-- Les numéros qui apparaissent ici ne sont PAS au format "+237" + 9 chiffres :
-- numéros étrangers ou numéros inutilisables, laissés tels quels volontairement.
SELECT id, name, phone
FROM chauffeur
WHERE phone IS NOT NULL
  AND phone NOT REGEXP '^\\+237[26][0-9]{8}$';
