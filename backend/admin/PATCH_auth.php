<?php
/*
 * =============================================================
 *  PATCH à ajouter dans backend/config/auth.php
 *  Copiez ces deux fonctions à la fin du fichier auth.php
 * =============================================================
 */

function require_admin_id() {
    if (empty($_SESSION["admin_id"]) || ($_SESSION["role"] ?? "") !== "admin") {
        json_response(["status" => "error", "message" => "Acces administrateur requis"], 401);
    }
    return (int) $_SESSION["admin_id"];
}
?>
