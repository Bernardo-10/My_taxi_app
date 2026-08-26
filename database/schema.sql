-- ================================================================
--  TaxiGo — schéma de base de données CENTRAL
--  Source de vérité unique, à committer sur GitHub
--
--  Généré le 2026-07-01 en réconciliant :
--    - l'export réel de production (taxi_bd.sql, sql103.infinityfree.com)
--    - database/bd.sql, admin_migration.sql, add_*.sql du repo
--    - le code PHP réel (backend/) pour vérifier ce qui est utilisé
--
--  Contenu :
--    - Les 5 tables réelles (admin, chauffeur, client, rides, sessions)
--    - Toutes les colonnes constatées en prod, y compris celles qui
--      n'existaient dans AUCUN fichier du repo (rides.accepted_at
--      -> cancelled_at, table sessions)
--    - Les UNIQUE KEY / INDEX prévus à l'origine mais jamais appliqués
--      en prod (voir section "SITUATION ACTUELLE EN PROD" plus bas)
--    - AUCUNE donnée réelle : seulement les 2 comptes de test
--      (id=1 client / id=1 chauffeur) + le compte admin de bootstrap
--    - PAS de triggers : accept_ride.php et complete_ride.php mettent
--      déjà à jour les totaux chauffeur manuellement en PHP (vérifié
--      dans le code). Des triggers dupliqueraient ces totaux.
--
--  Réexécutable : toutes les instructions utilisent IF NOT EXISTS,
--  donc ce script peut tourner sans risque sur une base vierge ou
--  sur la prod actuelle.
--
--  IMPORTANT — nom de la base de données :
--  Sur InfinityFree (et la plupart des mutualisés), le nom de la base
--  est attribué automatiquement par l'hébergeur (ex: if0_42292648_taxi_app)
--  et ne peut PAS être choisi. Ce script ne contient donc volontairement
--  aucun CREATE DATABASE / USE. Étapes pour un nouveau déploiement :
--    1. Créer une base vide via le panel de l'hébergeur, noter son nom
--    2. Se connecter dessus (phpMyAdmin, ou `mysql -D nom_de_la_base < schema.sql`)
--    3. Exécuter ce script
--    4. Mettre à jour backend/config/db.php ET backend/config/auth.php
--       (la classe DbSessionHandler a SES PROPRES identifiants de connexion,
--       distincts de db.php — les deux doivent être mis à jour)
-- ================================================================


-- ----------------------------------------------------------------
-- Table `admin`
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  username            VARCHAR(60)  NOT NULL,
  email               VARCHAR(120) NOT NULL,
  password_hash       VARCHAR(255) NOT NULL,
  session_token       VARCHAR(128) DEFAULT NULL,
  session_updated_at  TIMESTAMP NULL DEFAULT NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_admin_username (username),
  UNIQUE KEY uniq_admin_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Idempotent pour une base existante où la table existe déjà sans ces clés
ALTER TABLE admin
  ADD UNIQUE KEY IF NOT EXISTS uniq_admin_username (username),
  ADD UNIQUE KEY IF NOT EXISTS uniq_admin_email (email);


-- ----------------------------------------------------------------
-- Table `chauffeur`
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chauffeur (
  id                            INT AUTO_INCREMENT PRIMARY KEY,
  name                          VARCHAR(100) NOT NULL,
  phone                         VARCHAR(30)  DEFAULT NULL,
  email                         VARCHAR(120) DEFAULT NULL,
  password_hash                 VARCHAR(255) NOT NULL,
  plate                         VARCHAR(50)  NOT NULL,
  car_brand                     VARCHAR(80)  DEFAULT NULL,
  car_color                     VARCHAR(50)  DEFAULT NULL,
  session_token                 VARCHAR(128) DEFAULT NULL,
  session_updated_at            TIMESTAMP NULL DEFAULT NULL,
  status                        ENUM('active','disabled') NOT NULL DEFAULT 'active',
  is_online                     TINYINT(1) NOT NULL DEFAULT 0,
  total_accepted_amount_fcfa    BIGINT NOT NULL DEFAULT 0,
  total_accepted_rides          INT NOT NULL DEFAULT 0,
  total_completed_distance_km   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  total_completed_rides         INT NOT NULL DEFAULT 0,
  created_at                    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  driver_lat                    DOUBLE DEFAULT NULL,
  driver_lng                    DOUBLE DEFAULT NULL,
  update_position_driver        TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY uniq_chauffeur_email (email),
  UNIQUE KEY uniq_chauffeur_phone (phone),
  UNIQUE KEY uniq_chauffeur_plate (plate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE chauffeur
  ADD UNIQUE KEY IF NOT EXISTS uniq_chauffeur_email (email),
  ADD UNIQUE KEY IF NOT EXISTS uniq_chauffeur_phone (phone),
  ADD UNIQUE KEY IF NOT EXISTS uniq_chauffeur_plate (plate);


-- ----------------------------------------------------------------
-- Table `client`
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  full_name           VARCHAR(120) NOT NULL,
  phone               VARCHAR(30)  DEFAULT NULL,
  email               VARCHAR(120) DEFAULT NULL,
  password_hash       VARCHAR(255) NOT NULL,
  car_brand           VARCHAR(80)  DEFAULT NULL,
  car_color           VARCHAR(50)  DEFAULT NULL,
  session_token       VARCHAR(128) DEFAULT NULL,
  session_updated_at  TIMESTAMP NULL DEFAULT NULL,
  status              ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_client_email (email),
  UNIQUE KEY uniq_client_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE client
  ADD UNIQUE KEY IF NOT EXISTS uniq_client_email (email),
  ADD UNIQUE KEY IF NOT EXISTS uniq_client_phone (phone);


-- ----------------------------------------------------------------
-- Table `rides`
-- Colonnes accepted_at -> cancelled_at : existent en prod depuis
-- longtemps (ajoutées à la main via phpMyAdmin) mais ne sont écrites
-- par AUCUN fichier PHP actuellement (vérifié dans backend/chauffeur
-- et backend/client). Voir la section "Modifications de code" de la
-- réponse pour les activer.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rides (
  id                            INT AUTO_INCREMENT PRIMARY KEY,
  user_id                       INT NOT NULL,
  pickup                        VARCHAR(255) DEFAULT NULL,
  destination                   VARCHAR(255) DEFAULT NULL,
  pickup_lat                    DOUBLE DEFAULT NULL,
  pickup_lng                    DOUBLE DEFAULT NULL,
  destination_lat               DOUBLE DEFAULT NULL,
  destination_lng               DOUBLE DEFAULT NULL,
  distance_km                   FLOAT DEFAULT NULL,
  duration_min                  INT DEFAULT NULL,
  price_fcfa                    INT DEFAULT NULL,
  passengers                    INT DEFAULT 1,
  status                        ENUM('pending','accepted','arrived','started','completed','cancelled','cancelled_client','reported') NOT NULL DEFAULT 'pending',
  driver_id                     INT DEFAULT NULL,
  driver_name                   VARCHAR(100) DEFAULT NULL,
  driver_plate                  VARCHAR(50)  DEFAULT NULL,
  driver_lat                    DOUBLE DEFAULT NULL,
  driver_lng                    DOUBLE DEFAULT NULL,
  update_position_driver        TIMESTAMP NULL DEFAULT NULL,
  created_at                    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  accepted_at                   TIMESTAMP NULL DEFAULT NULL,
  arrived_at                    TIMESTAMP NULL DEFAULT NULL,
  started_at                    TIMESTAMP NULL DEFAULT NULL,
  completed_at                  TIMESTAMP NULL DEFAULT NULL,
  cancelled_at                  TIMESTAMP NULL DEFAULT NULL,
  client_problem_description    TEXT DEFAULT NULL,
  client_problem_at             TIMESTAMP NULL DEFAULT NULL,
  client_problem_resolved_at    TIMESTAMP NULL DEFAULT NULL,
  problem_description            TEXT DEFAULT NULL,
  INDEX idx_rides_user_status (user_id, status),
  INDEX idx_rides_driver_status (driver_id, status),
  INDEX idx_rides_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE rides
  ADD INDEX IF NOT EXISTS idx_rides_user_status (user_id, status),
  ADD INDEX IF NOT EXISTS idx_rides_driver_status (driver_id, status),
  ADD INDEX IF NOT EXISTS idx_rides_status_created (status, created_at),
  ADD COLUMN IF NOT EXISTS client_problem_resolved_at TIMESTAMP NULL DEFAULT NULL AFTER client_problem_at;


-- ----------------------------------------------------------------
-- Table `ride_refusals`
-- Ajoutée le 2026-07-01 pour corriger un bug de refuse_ride.php :
-- avant, refuser une course pending passait rides.status à
-- 'cancelled' pour TOUT LE MONDE, alors qu'un seul chauffeur avait
-- refusé. Un refus est maintenant local à un chauffeur : on
-- l'enregistre ici, la course reste 'pending' pour les autres.
-- Pas de limite de temps sur pending : si personne n'accepte,
-- c'est au client d'annuler (cancelled_client), pas au système.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_refusals (
  ride_id     INT NOT NULL,
  driver_id   INT NOT NULL,
  refused_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ride_id, driver_id),
  INDEX idx_refusals_driver (driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ----------------------------------------------------------------
-- Table `sessions`
-- Backend réel de session PHP (voir DbSessionHandler dans
-- backend/config/auth.php — session_set_save_handler). Ce n'est PAS
-- un reliquat : c'est ainsi que TOUTES les sessions PHP de l'app
-- sont stockées (client, chauffeur, admin confondus). MyISAM/latin1
-- conservés à l'identique de la prod pour éviter toute surprise.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id             VARCHAR(128) NOT NULL PRIMARY KEY,
  data           TEXT NOT NULL,
  last_activity  INT(11) NOT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;


-- ----------------------------------------------------------------
-- Comptes de bootstrap / test — mot de passe en clair : password
-- (sauf admin, voir note). Aucune autre donnée utilisateur incluse.
-- ----------------------------------------------------------------

-- Client de test (id=1)
-- Correction appliquée : le hash en prod avait 2 espaces en préfixe,
-- ce qui cassait password_verify() — corrigé ici.
INSERT INTO client (id, full_name, phone, email, password_hash, status)
VALUES (1, 'Client Test', '690000001', 'client@test.com',
        '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llCImXi4qAtV.i.U4tGFG', 'active')
ON DUPLICATE KEY UPDATE
  full_name = VALUES(full_name),
  phone = VALUES(phone),
  email = VALUES(email),
  password_hash = VALUES(password_hash),
  status = VALUES(status);

-- Chauffeur de test (id=1)
INSERT INTO chauffeur (id, name, phone, email, password_hash, plate, car_brand, car_color, status)
VALUES (1, 'Test Driver', '690000002', 'chauffeur@test.com',
        '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llCImXi4qAtV.i.U4tGFG',
        'LT 000 BD', 'Toyota', 'Jaune', 'active')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  phone = VALUES(phone),
  email = VALUES(email),
  password_hash = VALUES(password_hash),
  plate = VALUES(plate),
  car_brand = VALUES(car_brand),
  car_color = VALUES(car_color),
  status = VALUES(status);

-- Compte admin de bootstrap (mot de passe : à changer en prod via
-- password_hash('VotreMotDePasse', PASSWORD_BCRYPT))
INSERT INTO admin (username, email, password_hash)
VALUES ('admin', 'admin@taxigo.cm',
        '$2y$10$sR5k8wY/bNJI2p5eMJgX2OQqz1J4yiRXFhlm8qpDd9OB3jtjW3SiO')
ON DUPLICATE KEY UPDATE username = VALUES(username);


-- ================================================================
-- SITUATION ACTUELLE EN PROD (au 2026-07-01) — à appliquer une fois
-- ================================================================
-- L'export live confirme qu'aucune des contraintes UNIQUE ni des
-- index ci-dessus n'existe réellement sur sql103.infinityfree.com
-- (seules les clés primaires sont présentes). Conséquence concrète :
-- rien n'empêche aujourd'hui deux clients d'avoir le même email, ou
-- deux chauffeurs la même plaque.
--
-- Pour combler cet écart sur LA PROD ACTUELLE uniquement (une seule
-- fois, via phpMyAdmin), il suffit d'exécuter les blocs
-- "ALTER TABLE ... ADD ... IF NOT EXISTS" de ce fichier : ils sont
-- sans danger même si les tables contiennent déjà des données,
-- puisqu'aucun doublon d'email/téléphone/plaque n'existe actuellement
-- (vérifié dans l'export). Le reste du fichier (CREATE TABLE) sera
-- ignoré puisque les tables existent déjà.
-- ================================================================

-- ================================================================
-- TaxiGo — Migration Portefeuille chauffeur & commission 20%
-- Ajoute :
--   - wallet_balance_fcfa sur chauffeur
--   - table wallet_transactions
--
-- Réexécutable : toutes les instructions sont protégées par
-- IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- ================================================================

-- 1. Ajout du solde dénormalisé dans chauffeur
ALTER TABLE chauffeur
  ADD COLUMN IF NOT EXISTS wallet_balance_fcfa BIGINT NOT NULL DEFAULT 0
  COMMENT 'Solde actuel du portefeuille (dénormalisé)';

-- 2. Table des transactions du portefeuille
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  chauffeur_id  INT NOT NULL,
  type          VARCHAR(20) NOT NULL,          -- commission, recharge, ajustement
  amount_fcfa   BIGINT SIGNED NOT NULL,        -- positif = crédit, négatif = débit
  ride_id       INT NULL,                      -- lié à une course pour les commissions
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, completed, rejected
  operator      VARCHAR(50) NULL,              -- opérateur mobile money (ex: Orange, MTN)
  reference     VARCHAR(100) NULL,             -- référence de la transaction externe
  description   TEXT NULL,                     -- commentaire libre
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  validated_at  TIMESTAMP NULL,                -- date de validation (admin)
  INDEX idx_wallet_chauffeur (chauffeur_id),
  INDEX idx_wallet_status (status),
  INDEX idx_wallet_created (created_at),
  INDEX idx_wallet_chauffeur_created (chauffeur_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3. (Optionnel) On peut ajouter des clés étrangères si souhaité,
--    mais elles ne sont pas obligatoires pour le fonctionnement.
--    Je les laisse en commentaire pour éviter des contraintes
--    bloquantes sur des bases existantes.
-- ALTER TABLE wallet_transactions
--   ADD CONSTRAINT fk_wallet_chauffeur FOREIGN KEY (chauffeur_id) REFERENCES chauffeur(id),
--   ADD CONSTRAINT fk_wallet_ride FOREIGN KEY (ride_id) REFERENCES rides(id);
-- ================================================================
-- TaxiGo — Table de renouvellement de documents chauffeur
-- Séparée de `chauffeur` volontairement : un renouvellement soumis
-- ne doit jamais écraser le document "live" tant qu'un admin ne l'a
-- pas approuvé (voir rapport-kyc-chauffeur.md, §2). L'ancien document
-- reste celui qui compte pour le blocage à la mise en ligne jusqu'à
-- validation explicite.
-- ================================================================
CREATE TABLE IF NOT EXISTS chauffeur_document_renewals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chauffeur_id INT NOT NULL,
    document_group ENUM('cni','carte_grise','permit','capacity','license') NOT NULL,
    number VARCHAR(50) NOT NULL,
    expiration DATE NOT NULL,
    photo_recto VARCHAR(255) NULL,
    photo_verso VARCHAR(255) NULL,  -- NULL pour carte_grise (photo unique)
    status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    rejection_reason VARCHAR(255) NULL,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP NULL,
    FOREIGN KEY (chauffeur_id) REFERENCES chauffeur(id),
    INDEX idx_renewals_chauffeur_group (chauffeur_id, document_group),
    INDEX idx_renewals_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
ALTER TABLE chauffeur
  MODIFY kyc_status ENUM('incomplete', 'pending', 'approved', 'rejected')
  NOT NULL DEFAULT 'pending';