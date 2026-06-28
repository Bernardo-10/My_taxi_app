-- ================================================================
--  Migration admin — à exécuter dans taxi_app1
--  Une seule fois, après avoir appliqué bd.sql
-- ================================================================

USE taxi_app1;

-- 1. Table administrateurs
CREATE TABLE IF NOT EXISTS admin (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  username            VARCHAR(60)  NOT NULL UNIQUE,
  email               VARCHAR(120) NOT NULL UNIQUE,
  password_hash       VARCHAR(255) NOT NULL,
  session_token       VARCHAR(128) DEFAULT NULL,
  session_updated_at  TIMESTAMP NULL DEFAULT NULL,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 2. Compte admin par défaut  (mot de passe : Admin1234!)
--    Changez ce hash en production via : password_hash('VotreMotDePasse', PASSWORD_BCRYPT)
INSERT INTO admin (username, email, password_hash)
VALUES ('admin', 'admin@taxigo.cm',
        '$2y$10$sR5k8wY/bNJI2p5eMJgX2OQqz1J4yiRXFhlm8qpDd9OB3jtjW3SiO')
ON DUPLICATE KEY UPDATE username = VALUES(username);

-- 3. Corriger l'ENUM rides.status pour inclure les statuts réels
--    (ils existaient déjà via phpMyAdmin, mais on les formalise)
ALTER TABLE rides
  MODIFY COLUMN status
    ENUM('pending','accepted','arrived','started','completed','cancelled','reported')
    DEFAULT 'pending';

-- 4. Colonnes report utilisées par report_problem.php (client et chauffeur)
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS problem_description        TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS client_problem_description TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS client_problem_at          TIMESTAMP NULL DEFAULT NULL;

-- 5. Index utile pour les requêtes admin (filtres par date/statut)
ALTER TABLE rides
  ADD INDEX IF NOT EXISTS idx_rides_status_created (status, created_at);
