CREATE DATABASE IF NOT EXISTS taxi_app1
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_general_ci;

USE taxi_app1;

CREATE TABLE IF NOT EXISTS client (
  id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  phone VARCHAR(30) DEFAULT NULL,
  email VARCHAR(120) DEFAULT NULL,
  password_hash VARCHAR(255) NOT NULL,
  car_brand VARCHAR(80) DEFAULT NULL,
  car_color VARCHAR(50) DEFAULT NULL,
  session_token VARCHAR(128) DEFAULT NULL,
  session_updated_at TIMESTAMP NULL DEFAULT NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_client_email (email),
  UNIQUE KEY uniq_client_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS chauffeur (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(30) DEFAULT NULL,
  email VARCHAR(120) DEFAULT NULL,
  password_hash VARCHAR(255) NOT NULL,
  plate VARCHAR(50) NOT NULL,
  car_brand VARCHAR(80) DEFAULT NULL,
  car_color VARCHAR(50) DEFAULT NULL,
  session_token VARCHAR(128) DEFAULT NULL,
  session_updated_at TIMESTAMP NULL DEFAULT NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  is_online TINYINT(1) NOT NULL DEFAULT 0,

  total_accepted_amount_fcfa BIGINT NOT NULL DEFAULT 0,
  total_accepted_rides INT NOT NULL DEFAULT 0,

  total_completed_distance_km DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_completed_rides INT NOT NULL DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_chauffeur_email (email),
  UNIQUE KEY uniq_chauffeur_phone (phone),
  UNIQUE KEY uniq_chauffeur_plate (plate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS rides (
  id INT AUTO_INCREMENT PRIMARY KEY,

  user_id INT NOT NULL,

  pickup VARCHAR(255),
  destination VARCHAR(255),

  pickup_lat DOUBLE,
  pickup_lng DOUBLE,

  destination_lat DOUBLE,
  destination_lng DOUBLE,

  distance_km FLOAT,
  duration_min INT,

  price_fcfa INT,
  passengers INT DEFAULT 1,

  status ENUM('pending','accepted','arrived','started','completed','cancelled','cancelled_client','reported') DEFAULT 'pending',

  driver_id INT DEFAULT NULL,
  driver_name VARCHAR(100) DEFAULT NULL,
  driver_plate VARCHAR(50) DEFAULT NULL,

  driver_lat DOUBLE NULL,
  driver_lng DOUBLE NULL,

  update_position_driver TIMESTAMP NULL DEFAULT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_rides_user_status (user_id, status),
  INDEX idx_rides_driver_status (driver_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Migration si les tables existaient deja.
ALTER TABLE client
  ADD COLUMN IF NOT EXISTS car_brand VARCHAR(80) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS car_color VARCHAR(50) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS session_token VARCHAR(128) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS session_updated_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS status ENUM('active','disabled') NOT NULL DEFAULT 'active';

ALTER TABLE chauffeur
  ADD COLUMN IF NOT EXISTS phone VARCHAR(30) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS email VARCHAR(120) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS car_brand VARCHAR(80) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS car_color VARCHAR(50) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS session_token VARCHAR(128) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS session_updated_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS is_online TINYINT(1) NOT NULL DEFAULT 0 AFTER status;

ALTER TABLE rides
  MODIFY COLUMN user_id INT NOT NULL,
  MODIFY COLUMN driver_id INT DEFAULT NULL,
  MODIFY COLUMN driver_name VARCHAR(100) DEFAULT NULL,
  MODIFY COLUMN driver_plate VARCHAR(50) DEFAULT NULL,
  MODIFY COLUMN update_position_driver TIMESTAMP NULL DEFAULT NULL,
  MODIFY COLUMN status ENUM('pending','accepted','arrived','started','completed','cancelled','cancelled_client','reported') NOT NULL DEFAULT 'pending';

-- Comptes de test. Mot de passe: password
INSERT INTO client (id, full_name, phone, email, password_hash, status)
VALUES (1, 'Client Test', '690000001', 'client@test.com', '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llCImXi4qAtV.i.U4tGFG', 'active')
ON DUPLICATE KEY UPDATE
  full_name = VALUES(full_name),
  phone = VALUES(phone),
  email = VALUES(email),
  password_hash = VALUES(password_hash),
  status = VALUES(status);

INSERT INTO chauffeur (id, name, phone, email, password_hash, plate, car_brand, car_color, status)
VALUES (1, 'Test Driver', '690000002', 'chauffeur@test.com', '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llCImXi4qAtV.i.U4tGFG', 'LT 000 BD', 'Toyota', 'Jaune', 'active')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  phone = VALUES(phone),
  email = VALUES(email),
  password_hash = VALUES(password_hash),
  plate = VALUES(plate),
  car_brand = VALUES(car_brand),
  car_color = VALUES(car_color),
  status = VALUES(status);

DROP TRIGGER IF EXISTS rides_after_update_set_accepted_totals;
DELIMITER $$

CREATE TRIGGER rides_after_update_set_accepted_totals
AFTER UPDATE ON rides
FOR EACH ROW
BEGIN
  IF NEW.status = 'accepted' AND OLD.status <> 'accepted' AND NEW.driver_id IS NOT NULL THEN
    UPDATE chauffeur
    SET
      total_accepted_amount_fcfa = total_accepted_amount_fcfa + IFNULL(NEW.price_fcfa, 0),
      total_accepted_rides = total_accepted_rides + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.driver_id;
  END IF;
END$$

DELIMITER ;

DROP TRIGGER IF EXISTS rides_after_update_set_completed_totals;
DELIMITER $$

CREATE TRIGGER rides_after_update_set_completed_totals
AFTER UPDATE ON rides
FOR EACH ROW
BEGIN
  IF NEW.status = 'completed' AND OLD.status <> 'completed' AND NEW.driver_id IS NOT NULL THEN
    UPDATE chauffeur
    SET
      total_completed_distance_km = total_completed_distance_km + IFNULL(NEW.distance_km, 0),
      total_completed_rides = total_completed_rides + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.driver_id;
  END IF;
END$$

DELIMITER ;
