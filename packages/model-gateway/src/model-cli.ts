import { pathToFileURL } from "node:url";

import { loadModelGatewayConfiguration } from "./configuration.ts";
import {
  createBuiltinModelCatalog,
  diagnoseModelGatewayConfiguration,
  listGenerationModels,
  listModelProviders,
} from "./model-diagnostics.ts";

export async function runModelCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [command, ...options] = arguments_;
  const catalog = createBuiltinModelCatalog();
  if (command === "catalog") {
    const provider = option(options, "--provider");
    if (provider) {
      const models = listGenerationModels(provider, catalog);
      process.stdout.write(`${JSON.stringify({ provider, models }, null, 2)}\n`);
      return models.length === 0 ? 2 : 0;
    }
    process.stdout.write(`${JSON.stringify({ providers: listModelProviders(catalog) }, null, 2)}\n`);
    return 0;
  }
  if (command === "doctor") {
    const configuration = loadModelGatewayConfiguration(environment);
    const report = await diagnoseModelGatewayConfiguration(configuration, catalog);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ready ? 0 : 2;
  }
  process.stderr.write(
    "Usage: model-cli catalog [--provider <provider>] | doctor\n",
  );
  return 2;
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError(`${name} requires a value`);
  return value;
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  process.exitCode = await runModelCli(process.argv.slice(2));
}
