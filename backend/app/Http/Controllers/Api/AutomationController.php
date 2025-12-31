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
        if (($existingStatus['status'] ?? '') === 'running') {
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

        $command = $this->buildBackgroundCommand($nodeBinary, $scriptPath);
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

    public function status(): JsonResponse
    {
        $statusPath = storage_path('app/automation_status.json');
        $status = $this->readStatus($statusPath);

        if (!$status) {
            return response()->json([
                'status' => 'idle',
                'message' => 'Automation idle.',
            ]);
        }

        return response()->json($status);
    }

    private function buildBackgroundCommand(string $nodeBinary, string $scriptPath): string
    {
        $node = escapeshellarg($nodeBinary);
        $script = escapeshellarg($scriptPath);

        if (PHP_OS_FAMILY === 'Windows') {
            return sprintf('cmd /c start "" /B %s %s', $node, $script);
        }

        return sprintf('nohup %s %s >/dev/null 2>&1 &', $node, $script);
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
}
