<?php
header('Content-Type: application/json');
$iniFile = php_ini_loaded_file();
$iniLine = '';
if ($iniFile && file_exists($iniFile)) {
    $lines = file($iniFile, FILE_IGNORE_NEW_LINES);
    foreach ($lines as $line) {
        if (stripos(trim($line), 'extension_dir') === 0) {
            $iniLine = $line;
            break;
        }
    }
}
$drivers = [];
try {
    $drivers = PDO::getAvailableDrivers();
} catch (Throwable $e) {
    $drivers = ['error' => $e->getMessage()];
}
echo json_encode([
    'extension_dir' => ini_get('extension_dir'),
    'ini_extension_dir_line' => $iniLine,
    'drivers' => $drivers,
    'loaded_ini' => $iniFile,
]);
