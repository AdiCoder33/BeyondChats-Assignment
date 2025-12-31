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
        if ($force) {
            $env['SKIP_IF_UPDATED'] = 'false';
        }

        $process = new Process([$nodeBinary, $script], $workDir, $env);
        $process->setTimeout(null);
        $process->setIdleTimeout(null);
        $process->disableOutput();

        try {
            $process->start();
        } catch (\Throwable $error) {
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
}
