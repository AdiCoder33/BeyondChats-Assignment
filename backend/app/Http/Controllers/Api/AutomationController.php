<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\Process\Process;

class AutomationController extends Controller
{
    public function run(Request $request): JsonResponse
    {
        set_time_limit(0);

        $nodeBinary = env('AUTOMATION_NODE_BINARY', 'node');
        $workDir = base_path(env('AUTOMATION_WORKDIR', '../automation'));
        $script = env('AUTOMATION_SCRIPT', 'index.js');
        $force = $request->boolean('force', false);
        $statusPath = storage_path('app/automation_status.json');
        $logPath = env('AUTOMATION_LOG_FILE', storage_path('app/automation.log'));

        if (!is_dir($workDir)) {
            return response()->json([
                'status' => 'error',
                'message' => 'Automation directory not found.',
            ], 500);
        }

        $scriptPath = $workDir . DIRECTORY_SEPARATOR . $script;
        if (!file_exists($scriptPath)) {
            return response()->json([
                'status' => 'error',
                'message' => 'Automation script not found.',
            ], 500);
        }

        $existingStatus = $this->readStatus($statusPath);
        if (($existingStatus['status'] ?? '') === 'running' && !$this->isStale($existingStatus)) {
            return response()->json([
                'status' => 'running',
                'message' => 'Automation is already running.',
                'started_at' => $existingStatus['started_at'] ?? null,
            ], 409);
        }

        $env = array_merge($_ENV, $_SERVER);
        $systemRoot = getenv('SystemRoot') ?: ($env['SystemRoot'] ?? 'C:\\Windows');
        $pathValue = getenv('Path') ?: getenv('PATH') ?: ($env['Path'] ?? $env['PATH'] ?? '');
        $tempValue = getenv('TEMP') ?: ($env['TEMP'] ?? sys_get_temp_dir());

        $env['SystemRoot'] = $systemRoot;
        $env['windir'] = getenv('windir') ?: ($env['windir'] ?? $systemRoot);
        $env['Path'] = $pathValue;
        $env['PATH'] = $pathValue;
        $env['TEMP'] = $tempValue;
        $env['TMP'] = getenv('TMP') ?: ($env['TMP'] ?? $tempValue);
        $env['AUTOMATION_STATUS_FILE'] = $statusPath;
        if ($force) {
            $env['SKIP_IF_UPDATED'] = 'false';
        }

        $this->writeStatus($statusPath, [
            'status' => 'running',
            'started_at' => now()->toIso8601String(),
            'message' => 'Automation running.',
        ]);

        $this->appendLog($logPath, 'Automation started.');
        $command = $this->buildBackgroundCommand($nodeBinary, $scriptPath, $logPath);
        $process = Process::fromShellCommandline($command, $workDir, $env);

        try {
            $process->run();
        } catch (\Throwable $error) {
            $this->writeStatus($statusPath, [
                'status' => 'error',
                'finished_at' => now()->toIso8601String(),
                'message' => 'Automation failed to start.',
            ]);
            return response()->json([
                'status' => 'error',
                'message' => 'Automation failed to start.',
                'error' => $error->getMessage(),
            ], 500);
        }

        return response()->json([
            'status' => 'started',
            'message' => 'Automation started.',
            'pid' => $process->getPid(),
        ], 202);
    }

    public function status(Request $request): JsonResponse
    {
        $statusPath = storage_path('app/automation_status.json');
        $status = $this->readStatus($statusPath);
        $logPath = env('AUTOMATION_LOG_FILE', storage_path('app/automation.log'));

        if (!$status) {
            return response()->json([
                'status' => 'idle',
                'message' => 'Automation idle.',
            ]);
        }

        if (($status['status'] ?? '') === 'running' && $this->isStale($status)) {
            $status = [
                'status' => 'error',
                'message' => 'Automation stalled. Please run it again.',
                'started_at' => $status['started_at'] ?? null,
                'finished_at' => now()->toIso8601String(),
            ];
            $this->writeStatus($statusPath, $status);
            $this->appendLog($logPath, 'Automation stalled. Marked as error.');
        }

        if ($request->boolean('logs')) {
            $status['log_tail'] = $this->readLogTail($logPath, 50);
        }

        return response()->json($status);
    }

    private function buildBackgroundCommand(string $nodeBinary, string $scriptPath, string $logPath): string
    {
        $node = escapeshellarg($nodeBinary);
        $script = escapeshellarg($scriptPath);
        $log = escapeshellarg($logPath);

        if (PHP_OS_FAMILY === 'Windows') {
            return sprintf('cmd /c start "" /B %s %s >> %s 2>&1', $node, $script, $log);
        }

        return sprintf('nohup %s %s >> %s 2>&1 &', $node, $script, $log);
    }

    private function readStatus(string $statusPath): ?array
    {
        if (!file_exists($statusPath)) {
            return null;
        }

        $data = json_decode(file_get_contents($statusPath), true);
        if (!is_array($data)) {
            return null;
        }

        return $data;
    }

    private function writeStatus(string $statusPath, array $payload): void
    {
        $directory = dirname($statusPath);
        if (!is_dir($directory)) {
            mkdir($directory, 0775, true);
        }

        file_put_contents($statusPath, json_encode($payload, JSON_PRETTY_PRINT));
    }

    private function isStale(array $status): bool
    {
        $maxMinutes = (int) env('AUTOMATION_MAX_MINUTES', 30);
        $lastUpdate = $status['last_updated_at'] ?? $status['started_at'] ?? null;
        if (!$lastUpdate) {
            return false;
        }

        $lastTimestamp = strtotime($lastUpdate);
        if ($lastTimestamp === false) {
            return false;
        }

        return (time() - $lastTimestamp) > ($maxMinutes * 60);
    }

    private function appendLog(string $logPath, string $message): void
    {
        $directory = dirname($logPath);
        if (!is_dir($directory)) {
            mkdir($directory, 0775, true);
        }

        $line = '[' . now()->toIso8601String() . '] ' . $message . PHP_EOL;
        file_put_contents($logPath, $line, FILE_APPEND);
    }

    private function readLogTail(string $logPath, int $maxLines): array
    {
        if (!file_exists($logPath)) {
            return [];
        }

        $lines = @file($logPath, FILE_IGNORE_NEW_LINES);
        if (!is_array($lines)) {
            return [];
        }

        return array_slice($lines, -$maxLines);
    }
}
