<?php
// modules/zho/public/leaderboard.php
require_once '../../../mainfile.php';
require_once XOOPS_ROOT_PATH . '/header.php';

$dbFile = XOOPS_ROOT_PATH . '/modules/zho/data/leaderboard.sqlite';
if (!file_exists($dbFile)) {
  echo '<h1>Leaderboard non disponible</h1>';
  echo '<p>Le leaderboard SQLite n\'a pas encore été initialisé.</p>';
  require_once XOOPS_ROOT_PATH . '/footer.php';
  exit;
}

$pdo = new PDO('sqlite:' . $dbFile);
$stmt = $pdo->query(
  'SELECT u.username, l.points, l.wins, l.losses, l.last_update
   FROM leaderboard l
   JOIN users u ON u.id = l.user_id
   ORDER BY l.points DESC, l.wins DESC, u.username ASC
   LIMIT 20'
);
$rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
?>
<h1>Classement ZHO</h1>
<table border="1" cellpadding="6" cellspacing="0">
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
    <?php foreach ($rows as $i => $row): ?>
      <tr>
        <td><?= $i + 1 ?></td>
        <td><?= htmlspecialchars($row['username']) ?></td>
        <td><?= (int) $row['points'] ?></td>
        <td><?= (int) $row['wins'] ?></td>
        <td><?= (int) $row['losses'] ?></td>
        <td><?= htmlspecialchars($row['last_update']) ?></td>
      </tr>
    <?php endforeach; ?>
  </tbody>
</table>
<?php
require_once XOOPS_ROOT_PATH . '/footer.php';
