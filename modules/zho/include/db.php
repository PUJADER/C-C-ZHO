<?php
// modules/zho/include/db.php
// Fichiers de connexion / accès DB - version NPDS-style.
function zho_db_connect() {
  $dbFile = XOOPS_ROOT_PATH . '/modules/zho/data/leaderboard.sqlite';
  if (!file_exists($dbFile)) {
    return null;
  }
  return new PDO('sqlite:' . $dbFile);
}
