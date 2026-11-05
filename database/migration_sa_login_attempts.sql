-- CHANTIER S-A — table du limiteur de tentatives (connexion / inscription).
-- À exécuter UNE FOIS dans phpMyAdmin (onglet SQL), base if0_42292648_taxi_app.
-- Tant que cette table n'existe pas, le limiteur ne bloque rien (les connexions
-- continuent de fonctionner) : on peut donc déposer les fichiers avant ou après.

CREATE TABLE IF NOT EXISTS login_attempts (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  scope       VARCHAR(12)  NOT NULL,            -- 'login' ou 'register'
  ip          VARCHAR(45)  NOT NULL,
  ident       CHAR(64)     NOT NULL,            -- SHA-256 de l'identifiant saisi (jamais le texte)
  created_at  INT UNSIGNED NOT NULL,            -- heure Unix
  KEY idx_attempts_ip   (scope, ip, created_at),
  KEY idx_attempts_ident (scope, ip, ident, created_at)
) DEFAULT CHARSET=utf8mb4;

-- ── FACULTATIF : nettoyer les anciennes sessions "anonymes" ─────────────
-- Avant ce chantier, chaque visite (même sans connexion) créait une ligne dans
-- `sessions`. Cette requête supprime celles qui ne contiennent aucun utilisateur
-- connecté. (Les sessions de personnes connectées contiennent "role|".)
-- Lecture seule d'abord, pour voir combien de lignes sont concernées :
SELECT COUNT(*) AS lignes_anonymes FROM sessions WHERE data NOT LIKE '%role|%';
-- Puis, si le nombre vous paraît normal, décommentez la ligne suivante :
-- DELETE FROM sessions WHERE data NOT LIKE '%role|%';
