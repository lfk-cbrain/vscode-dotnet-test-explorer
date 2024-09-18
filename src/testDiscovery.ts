import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Executor } from "./executor";
import { Logger } from "./logger";
import { IMessage } from "./messages";
import * as vscode from "vscode";
import { performance } from "perf_hooks";

export interface IDiscoverTestsResult {
    testNames: string[];
    warningMessage?: IMessage;
}

export let testNameMappings: { originalName: string, normalizedName: string }[] = [];


export async function discoverTests(testDirectoryPath: string, dotnetTestOptions: string): Promise<IDiscoverTestsResult> {
    const startTime = performance.now();

    try {
        const stdout = await executeDotnetTest(testDirectoryPath, dotnetTestOptions);

        const extractTestNamesStartTime = performance.now();
        const testNames = await extractTestNames(stdout);
        const extractTestNamesEndTime = performance.now();
        Logger.Log(`extractTestNames completed in ${extractTestNamesEndTime - extractTestNamesStartTime} milliseconds`);

        if (!isMissingFqNames(testNames)) {
            const endTime = performance.now();
            Logger.Log(`discoverTests completed in ${endTime - startTime} milliseconds`);
            return { testNames };
        }

        const extractAssemblyPathsStartTime = performance.now();
        const assemblyPaths = extractAssemblyPaths(stdout);
        const extractAssemblyPathsEndTime = performance.now();
        Logger.Log(`extractAssemblyPaths completed in ${extractAssemblyPathsEndTime - extractAssemblyPathsStartTime} milliseconds`);

        if (assemblyPaths.length === 0) {
            throw new Error(`Couldn't extract assembly paths from dotnet test output: ${stdout}`);
        }

        try {
            const discoverTestsWithVstestStartTime = performance.now();
            const results = await discoverTestsWithVstest(assemblyPaths, testDirectoryPath);
            const discoverTestsWithVstestEndTime = performance.now();
            const endTime = performance.now();

            Logger.Log(`discoverTestsWithVstest completed in ${discoverTestsWithVstestEndTime - discoverTestsWithVstestStartTime} milliseconds`);
            Logger.Log(`discoverTests completed in ${endTime - startTime} milliseconds`);
            return { testNames: results };
        } catch (error) {
            if (error instanceof ListFqnNotSupportedError) {
                const endTime = performance.now();
                Logger.Log(`discoverTests completed in ${endTime - startTime} milliseconds`);
                return {
                    testNames,
                    warningMessage: {
                        text: "dotnet sdk >=2.1.2 required to retrieve fully qualified test names. Returning non FQ test names.",
                        type: "DOTNET_SDK_FQN_NOT_SUPPORTED",
                    },
                };
            }
            throw error;
        }
    } catch (error) {
        const endTime = performance.now();
        Logger.Log(`discoverTests completed in ${endTime - startTime} milliseconds`);
        throw error;
    }
}

function executeDotnetTest(testDirectoryPath: string, dotnetTestOptions: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const command = `dotnet test -t -v=q${dotnetTestOptions}`;

        Logger.Log(`Executing ${command} in ${testDirectoryPath}`);

        Executor.exec(command, (err: Error, stdout: string, stderr: string) => {
            if (err) {
                Logger.LogError(`Error while executing ${command}`, stdout);

                reject(err);
                return;
            }

            resolve(stdout);
        }, testDirectoryPath);
    });
}

async function extractTestNames(testCommandStdout: string): Promise<string[]> {
    const splits = testCommandStdout.split(/available:/g);

    const tests = splits[1];

    const testDir = await findCucumberTestDirectory();

    Logger.Log("Tests:\n" + tests);

    return Promise.all(
        tests
            .split(/[\r\n]+/g)
            .filter(item => item && item.startsWith("    "))
            .map(async (testName) => {
                // Check if it's a Cucumber test and normalize if necessary
                if (isCucumberTest(testName)) {
                    const normalizedName = await normalizeCucumberTestName(testName, testDir);

                    // Store the mapping for later reference when running the test
                    testNameMappings.push({
                        originalName: testName,
                        normalizedName: normalizedName
                    });

                    return normalizedName;
                }
                // If it's a unit test, leave it unchanged
                return testName;
            })
    )
        .then(results => results.sort().map(item => item.trim()));
}
function extractAssemblyPaths(testCommandStdout: string): string[] {
    /*
    * The string we need to parse is localized
    * (see https://github.com/microsoft/vstest/blob/018b6e4cc6e0ea7c8761c2a2f89c3e5032db74aa/src/Microsoft.TestPlatform.Build/Resources/xlf/Resources.xlf#L15-L18).
    **/
    const testRunLineStrings = [
        "Testovací běh pro {0} ({1})",         // cs
        "Testlauf für \"{0}\" ({1})",          // de
        "Test run for {0} ({1})",              // en
        "Serie de pruebas para {0} ({1})",     // es
        "Série de tests pour {0} ({1})",       // fr
        "Esecuzione dei test per {0} ({1})",   // it
        "{0} ({1}) のテスト実行",               // ja
        "{0}({1})에 대한 테스트 실행",          // ko
        "Przebieg testu dla: {0} ({1})",       // pl
        "Execução de teste para {0} ({1})",    // pt-BR
        "Тестовый запуск для {0} ({1})",       // ru
        "{0} ({1}) için test çalıştırması",    // tr
        "{0} ({1})的测试运行",                  // zh-Hans
        "{0} 的測試回合 ({1})"                  // zh-Hant
    ];
    // construct regex that matches any of the above localized strings
    const r = "^(?:" + testRunLineStrings
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) // escape characters
        .map((s) => s.replace("\\{0\\}", "(.+\\.dll)").replace("\\{1\\}", ".+"))
        .join("|")
        + ")$";
    const testRunLineRegex = new RegExp(r, "gm")
    const results = [];
    let match = null;

    do {
        match = testRunLineRegex.exec(testCommandStdout);
        if (match) {
            const assemblyPath = match.find((capture, i) => capture && i != 0); // first capture group is the whole match
            results.push(assemblyPath);
        }
    }
    while (match);

    return results;
}

function isMissingFqNames(testNames: string[]): boolean {
    return testNames.some((name) => !name.includes("."));
}

function isCucumberTest(testName: string): boolean {
    return testName.includes("::")
}

async function normalizeCucumberTestName(testName: string, testDir: string): Promise<string> {
    // Split on the "::" which separates different sections of the Cucumber test name
    const parts = testName.split("::").map(part => part.trim());

    // Convert each part into a dot-delimited, PascalCase format
    const pascalCaseParts = parts.map(part => toPascalCase(part));

    // If a test directory was found, prepend it to the test name
    if (testDir) {
        testDir = path.basename(testDir);
        return `${testDir}.${pascalCaseParts.join(".")}`;
    }

    return `Cucumber.${pascalCaseParts.join(".")}`;
}

async function findCucumberTestDirectory(): Promise<string | undefined> {
    // Find all .feature files
    const featureFiles = await vscode.workspace.findFiles('**/*.feature', '**/node_modules/**');

    if (featureFiles.length === 0) {
        return undefined; // No .feature files found
    }

    // Collect all unique parent directories of the found .feature files
    const directories = new Set<string>();
    featureFiles.forEach(file => {
        const dir = vscode.Uri.joinPath(file, "..").fsPath;
        directories.add(dir);
    });

    // Convert the set to an array for easier processing
    const dirArray = Array.from(directories);

    // Check each directory for a suitable parent directory
    for (const dir of dirArray) {
        const parentDir = path.resolve(dir, '..');
        if (path.basename(parentDir).toLowerCase().includes('test')) {
            if (parentDir !== dir) {
                const parentContents = await vscode.workspace.fs.readDirectory(vscode.Uri.file(parentDir));
                // If the parent directory is empty or only contains our directories, return it
                const onlyHasDirectories = parentContents.every(([_, type]) =>
                    type === vscode.FileType.Directory);

                if (onlyHasDirectories) {
                    return parentDir;
                }

            } else {
                return dir;
            }
        }
    }
    // Default to the first directory if no special conditions are met
    return dirArray[0];
}

function toPascalCase(input: string): string {
    return input
        .toLowerCase()
        .split(/\s+/g)  // Split by whitespace
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))  // Capitalize each word
        .join("");  // Join them back without spaces
}

function discoverTestsWithVstest(assemblyPaths: string[], testDirectoryPath: string): Promise<string[]> {
    const testOutputFilePath = prepareTestOutput();
    return executeDotnetVstest(assemblyPaths, testOutputFilePath, testDirectoryPath)
        .then(() => readVstestTestNames(testOutputFilePath))
        .then((result) => {
            cleanTestOutput(testOutputFilePath);
            return result;
        })
        .catch((err) => {
            cleanTestOutput(testOutputFilePath);
            throw err;
        });
}

function readVstestTestNames(testOutputFilePath: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        fs.readFile(testOutputFilePath, "utf8", (err, data: string) => {
            if (err) {
                reject(err);
                return;
            }

            const results = data
                .split(/[\r\n]+/g)
                .filter((s) => !!s)
                .sort();

            resolve(results);
        });
    });
}

function prepareTestOutput(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-explorer-discover-"));
    return path.join(tempDir, "output.txt");
}

function cleanTestOutput(testOutputFilePath: string) {
    if (fs.existsSync(testOutputFilePath)) {
        fs.unlinkSync(testOutputFilePath);
    }

    fs.rmdirSync(path.dirname(testOutputFilePath));
}

function executeDotnetVstest(assemblyPaths: string[], listTestsTargetPath: string, testDirectoryPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const testAssembliesParam = assemblyPaths.map((f) => `"${f}"`).join(" ");
        const command = `dotnet vstest ${testAssembliesParam} /ListFullyQualifiedTests /ListTestsTargetPath:"${listTestsTargetPath}"`;

        Logger.Log(`Executing ${command} in ${testDirectoryPath}`);

        Executor.exec(
            command,
            (err: Error, stdout: string, stderr: string) => {
                if (err) {
                    Logger.LogError(`Error while executing ${command}.`, err);

                    const flagNotRecognizedRegex = /\/ListFullyQualifiedTests/m;
                    if (flagNotRecognizedRegex.test(stderr)) {
                        reject(new ListFqnNotSupportedError());
                    } else {
                        reject(err);
                    }

                    return;
                }

                resolve(stdout);
            }, testDirectoryPath);
    });
}

class ListFqnNotSupportedError extends Error {
    constructor() {
        super("Dotnet vstest doesn't support /ListFullyQualifiedTests switch.");

        Error.captureStackTrace(this, ListFqnNotSupportedError);
    }
}
