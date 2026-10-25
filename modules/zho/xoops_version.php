<?php
// xoops_version.php
$modversion['name'] = 'ZHO';
$modversion['version'] = '0.1.0';
$modversion['description'] = 'Module de lobby, rooms, chat et leaderboard pour ZHO';
$modversion['author'] = 'ZHO Community';
$modversion['credits'] = 'ZHO';
$modversion['license'] = 'MIT';
$modversion['official'] = 0;
$modversion['status'] = 'Alpha';
$modversion['dirname'] = 'zho';
$modversion['image'] = 'images/logo.png';
$modversion['hasMain'] = 1;
$modversion['hasAdmin'] = 1;
$modversion['adminindex'] = 'admin/index.php';
$modversion['adminmenu'] = 'admin/menu.php';
$modversion['templates'] = [];
$modversion['sqlfile']['mysql'] = 'sql/zho_schema.sql';
$modversion['tables'] = [
  'zho_users',
  'zho_rooms',
  'zho_room_members',
  'zho_room_messages',
  'zho_reports',
  'zho_matches',
  'zho_leaderboard',
  'zho_settings'
];
