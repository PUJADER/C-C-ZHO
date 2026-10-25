<?php
function zho_db_connect()
{
    $dbFile = dirname(__FILE__) . '/../data/leaderboard.sqlite';

    if (!file_exists($dbFile)) {
        return null;
    }

    try {
        $pdo = new PDO('sqlite:' . $dbFile);
        return $pdo;
    } catch (Exception $e) {
        return null;
    }
}
