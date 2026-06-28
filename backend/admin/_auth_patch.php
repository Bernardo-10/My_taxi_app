<?php
// ═══════════════════════════════════════════════════════════
//  PATCH auth.php — ajouter ces deux fonctions dans
//  backend/config/auth.php  (après require_driver_id)
// ═══════════════════════════════════════════════════════════

// Ajouter aussi store_session_token() pour la table "admin"
// (la fonction existante accepte déjà un $table dynamique,
//  aucune modification nécessaire).

function require_admin_id() {
    if (empty($_SESSION["admin_id"]) || ($_SESSION["role"] ?? "") !== "admin") {
        json_response(["status" => "error", "message" => "Accès administrateur requis"], 401);
    }
    return (int) $_SESSION["admin_id"];
}
?>
