<?php
// Ce fichier est un MVP de leaderboard.
// 1) initialise le fichier SQLite :
//    sqlite3 data/leaderboard.sqlite < sql/schema.sql
// 2) assure-toi que le dossier data/ existe.

$dbFile = __DIR__ . '/../data/leaderboard.sqlite';

if (!file_exists($dbFile)) {
  echo '<h1>Leaderboard non initialisé</h1>';
  echo '<p>Fais : sqlite3 data/leaderboard.sqlite < sql/schema.sql</p>';
  exit;
}

$pdo = new PDO('sqlite:' . $dbFile);
$stmt = $pdo->query(
  'SELECT u.username, l.points, l.wins, l.losses, l.last_update
   FROM leaderboard l
   JOIN users u ON u.id = l.user_id
   ORDER BY l.points DESC, l.wins DESC, u.username ASC
   LIMIT 50'
);
$rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
?>

<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <title>Leaderboard</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 32px; background: #0f172a; color: #e2e8f0; }
      table { border-collapse: collapse; width: 700px; }
      th, td { border: 1px solid #334155; padding: 10px 14px; text-align: left; }
      th { background: #1e293b; }
      tr:nth-child(even) { background: #111827; }
    </style>
  </head>
  <body>
    <h1>Classement Zero Hour</h1>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Joueur</th>
          <th>Points</th>
          <th>Victoires</th>
          <th>Défaites</th>
          <th>Dernière MAJ</th>
        </tr>
      </thead>
      <tbody>
        <?php foreach ($rows as $index => $row): ?>
          <tr>
            <td><?= $index + 1 ?></td>
            <td><?= htmlspecialchars($row['username']) ?></td>
            <td><?= (int) $row['points'] ?></td>
            <td><?= (int) $row['wins'] ?></td>
            <td><?= (int) $row['losses'] ?></td>
            <td><?= htmlspecialchars($row['last_update']) ?></td>
          </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
  </body>
</html>
