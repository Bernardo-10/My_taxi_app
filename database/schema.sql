-- ================================================================
--  TaxiGo — schéma de base de données CENTRAL (structure seulement)
--  Source de vérité unique, à committer sur GitHub
--
--  Mis à jour le 2026-10-06 à partir de l'export RÉEL de production
--  (if0_42292648_taxi_app, MariaDB 11.4, export du 2026-10-05) : les 11
--  tables, colonnes et index ci-dessous ont été comparés un par un à cet
--  export (information_schema) — aucun écart.
--
--  Tables : admin, chauffeur, client, rides, ride_refusals,
--           chauffeur_document_reviews, chauffeur_document_renewals,
--           wallet_transactions, push_subscriptions, fcm_oauth_cache,
--           sessions
--
--  Ce fichier ne contient AUCUNE donnée. Les comptes de test
--  (client/chauffeur de démonstration, mot de passe « password ») sont
--  dans database/seed_dev.sql : à n'utiliser qu'en local, jamais en prod.
--  PAS de triggers : accept_ride.php et complete_ride.php mettent déjà à
--  jour les totaux chauffeur en PHP.
--
--  Réexécutable : CREATE TABLE IF NOT EXISTS partout, donc sans risque
--  sur une base vierge comme sur la prod actuelle (qui est à jour).
--  Une base plus ancienne que celle de prod (colonnes KYC/wallet de
--  `chauffeur` absentes) ne serait PAS complétée par ce fichier : le
--  CREATE TABLE IF NOT EXISTS ignore une table qui existe déjà.
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
--    5. Créer le compte admin (password_hash('VotreMotDePasse', PASSWORD_BCRYPT))
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
  -- Portefeuille (dénormalisé : le détail est dans wallet_transactions)
  wallet_balance_fcfa           BIGINT NOT NULL DEFAULT 0 COMMENT 'Solde actuel du portefeuille (dénormalisé)',
  -- Vérification d'identité (KYC). 'incomplete' = compte créé sans documents
  kyc_status                    ENUM('incomplete','pending','approved','rejected') NOT NULL DEFAULT 'pending',
  kyc_rejection_reason          VARCHAR(255) DEFAULT NULL,
  kyc_reviewed_at               TIMESTAMP NULL DEFAULT NULL,
  -- Documents : numéro, date d'expiration, photos (chemins de fichiers)
  cni_number                    VARCHAR(50)  DEFAULT NULL,
  cni_expiration                DATE DEFAULT NULL,
  cni_photo_recto               VARCHAR(255) DEFAULT NULL,
  cni_photo_verso               VARCHAR(255) DEFAULT NULL,
  carte_grise_immat             VARCHAR(50)  DEFAULT NULL,
  carte_grise_expiration        DATE DEFAULT NULL,
  carte_grise_photo             VARCHAR(255) DEFAULT NULL,
  permit_number                 VARCHAR(50)  DEFAULT NULL,
  permit_expiration             DATE DEFAULT NULL,
  permit_photo_recto            VARCHAR(255) DEFAULT NULL,
  permit_photo_verso            VARCHAR(255) DEFAULT NULL,
  capacity_number               VARCHAR(50)  DEFAULT NULL,
  capacity_expiration           DATE DEFAULT NULL,
  capacity_photo_recto          VARCHAR(255) DEFAULT NULL,
  capacity_photo_verso          VARCHAR(255) DEFAULT NULL,
  license_number                VARCHAR(50)  DEFAULT NULL,
  license_expiration            DATE DEFAULT NULL,
  license_photo_recto           VARCHAR(255) DEFAULT NULL,
  license_photo_verso           VARCHAR(255) DEFAULT NULL,
  -- Colonne présente en prod mais lue/écrite par aucun fichier du code
  -- (c'est kyc_status qui porte l'état « incomplet »). Gardée pour rester
  -- identique à la prod ; à supprimer lors d'un nettoyage.
  incomplete                    TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_chauffeur_email (email),
  UNIQUE KEY uniq_chauffeur_phone (phone),
  UNIQUE KEY uniq_chauffeur_plate (plate),
  KEY idx_chauffeur_kyc_status (kyc_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE chauffeur
  ADD UNIQUE KEY IF NOT EXISTS uniq_chauffeur_email (email),
  ADD UNIQUE KEY IF NOT EXISTS uniq_chauffeur_phone (phone),
  ADD UNIQUE KEY IF NOT EXISTS uniq_chauffeur_plate (plate),
  ADD KEY IF NOT EXISTS idx_chauffeur_kyc_status (kyc_status);


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
  status                        ENUM('pending','accepted','arrived','started','completed','cancelled','cancelled_client','reported','expired') NOT NULL DEFAULT 'pending',
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
  problem_description           TEXT DEFAULT NULL,
  problem_at                    TIMESTAMP NULL DEFAULT NULL,
  problem_resolved_at           TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_rides_user_status (user_id, status),
  INDEX idx_rides_driver_status (driver_id, status),
  INDEX idx_rides_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE rides
  ADD INDEX IF NOT EXISTS idx_rides_user_status (user_id, status),
  ADD INDEX IF NOT EXISTS idx_rides_driver_status (driver_id, status),
  ADD INDEX IF NOT EXISTS idx_rides_status_created (status, created_at);

-- client_problem_resolved_at : lue/écrite par backend/admin/resolve_client_problem.php,
-- list_problems.php et list_rides.php. Absente de ce fichier jusqu'au lot F1 ;
-- le ADD COLUMN IF NOT EXISTS est sans effet sur une base qui l'a déjà.
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS client_problem_resolved_at TIMESTAMP NULL DEFAULT NULL AFTER client_problem_at;

-- problem_at / problem_resolved_at (lot F4) : signalement du CHAUFFEUR, non terminal
-- (la course garde son statut ; l'admin est alerté puis marque « traité »).
-- Voir database/migration_lot_f4.sql pour une base existante.
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS problem_at          TIMESTAMP NULL DEFAULT NULL AFTER problem_description,
  ADD COLUMN IF NOT EXISTS problem_resolved_at TIMESTAMP NULL DEFAULT NULL AFTER problem_at;

-- Statut 'expired' (lot F3b) : course 'pending' sans chauffeur au bout de 30 min
-- (voir backend/common/ride_expiry.php). Pour une base existante, vérifier la
-- liste actuelle avec SHOW COLUMNS FROM rides LIKE 'status' avant d'exécuter
-- (voir database/migration_lot_f3b.sql). Sans effet si 'expired' est déjà là.
ALTER TABLE rides
  MODIFY COLUMN status ENUM('pending','accepted','arrived','started','completed','cancelled','cancelled_client','reported','expired') NOT NULL DEFAULT 'pending';


-- ----------------------------------------------------------------
-- Table `ride_refusals`
-- Ajoutée le 2026-07-01 pour corriger un bug de refuse_ride.php :
-- avant, refuser une course pending passait rides.status à
-- 'cancelled' pour TOUT LE MONDE, alors qu'un seul chauffeur avait
-- refusé. Un refus est maintenant local à un chauffeur : on
-- l'enregistre ici, la course reste 'pending' pour les autres.
-- Une course pending que personne n'accepte expire au bout de 30 min
-- (statut 'expired', voir backend/common/ride_expiry.php) ; le client
-- peut aussi l'annuler avant (cancelled_client).
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_refusals (
  ride_id     INT NOT NULL,
  driver_id   INT NOT NULL,
  refused_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ride_id, driver_id),
  INDEX idx_refusals_driver (driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ----------------------------------------------------------------
-- Table `chauffeur_document_reviews`
-- Décision admin par document (cni, carte_grise, permit, capacity, license),
-- une ligne par chauffeur et par document. MyISAM/latin1 conservés comme en prod.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chauffeur_document_reviews` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `chauffeur_id` int(10) UNSIGNED NOT NULL,
  `document_group` enum('cni','carte_grise','permit','capacity','license') NOT NULL,
  `status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `rejection_reason` text DEFAULT NULL,
  `reviewed_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_chauffeur_document` (`chauffeur_id`,`document_group`)
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- ----------------------------------------------------------------
-- Table `chauffeur_document_renewals`
-- Renouvellement d'un document arrivé à expiration, soumis par le chauffeur
-- puis validé ou rejeté par l'admin. MyISAM/latin1 conservés comme en prod.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chauffeur_document_renewals` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `chauffeur_id` int(11) NOT NULL,
  `document_group` enum('cni','carte_grise','permit','capacity','license') NOT NULL,
  `number` varchar(50) NOT NULL,
  `expiration` date NOT NULL,
  `photo_recto` varchar(255) DEFAULT NULL,
  `photo_verso` varchar(255) DEFAULT NULL,
  `status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `rejection_reason` varchar(255) DEFAULT NULL,
  `submitted_at` timestamp NULL DEFAULT current_timestamp(),
  `reviewed_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_renewals_pending` (`chauffeur_id`,`document_group`,`status`)
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- ----------------------------------------------------------------
-- Table `wallet_transactions`
-- Mouvements du portefeuille chauffeur (recharges, commissions...).
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `wallet_transactions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `chauffeur_id` int(11) NOT NULL,
  `type` varchar(20) NOT NULL,
  `amount_fcfa` bigint(20) NOT NULL,
  `ride_id` int(11) DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'pending',
  `operator` varchar(50) DEFAULT NULL,
  `reference` varchar(100) DEFAULT NULL,
  `description` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `validated_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_wallet_chauffeur` (`chauffeur_id`),
  KEY `idx_wallet_status` (`status`),
  KEY `idx_wallet_created` (`created_at`),
  KEY `idx_wallet_chauffeur_created` (`chauffeur_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ----------------------------------------------------------------
-- Table `push_subscriptions`
-- Jetons FCM des appareils (un compte peut en avoir plusieurs).
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `push_subscriptions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_type` enum('client','chauffeur') NOT NULL,
  `user_id` int(11) NOT NULL,
  `fcm_token` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_token` (`fcm_token`),
  KEY `idx_user` (`user_type`,`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ----------------------------------------------------------------
-- Table `fcm_oauth_cache`
-- Cache du jeton d'accès OAuth de Firebase (une seule ligne, id = 1).
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `fcm_oauth_cache` (
  `id` int(11) NOT NULL DEFAULT 1,
  `access_token` text NOT NULL,
  `expires_at` datetime NOT NULL,
  PRIMARY KEY (`id`)
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
