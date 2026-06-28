<?php
// Garde partagée — inclure après auth.php dans tous les endpoints admin.
if (!function_exists("require_admin_id")) {
    function require_admin_id() {
        if (empty($_SESSION["admin_id"]) || ($_SESSION["role"] ?? "") !== "admin") {
            json_response(["status" => "error", "message" => "Accès administrateur requis"], 401);
        }
        return (int) $_SESSION["admin_id"];
    }
}
?>
