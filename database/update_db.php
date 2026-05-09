<?php
$conn = new mysqli("localhost", "root", "", "taxi_app1");

if ($conn->connect_error) {
    die("Connection failed: " . $conn->connect_error);
}

// Modifier la colonne status en ENUM
$sql1 = "ALTER TABLE rides MODIFY COLUMN status ENUM('pending', 'accepted', 'cancelled', 'completed') DEFAULT 'pending'";
if ($conn->query($sql1) === TRUE) {
    echo "Status column updated successfully\n";
} else {
    echo "Error updating status column: " . $conn->error . "\n";
}

// Ajouter la colonne updated_at si elle n'existe pas
$sql2 = "ALTER TABLE rides ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP";
if ($conn->query($sql2) === TRUE) {
    echo "Updated_at column added successfully\n";
} else {
    echo "Error adding updated_at column: " . $conn->error . "\n";
}

$conn->close();
?>