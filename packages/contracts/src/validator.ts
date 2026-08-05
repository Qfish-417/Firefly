import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import formatsPlugin, { type FormatsPlugin } from "ajv-formats";
import contractSchema from "../schemas/v1/firefly-contracts.schema.json" with { type: "json" };

import type { ContractName } from "./types.ts";

export interface ContractValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});

(formatsPlugin as unknown as FormatsPlugin)(ajv);
ajv.addSchema(contractSchema);

const validators = new Map<ContractName, ValidateFunction>();

function getValidator(contractName: ContractName): ValidateFunction {
  const cached = validators.get(contractName);
  if (cached) {
    return cached;
  }

  const schemaId = `${contractSchema.$id}#/$defs/${contractName}`;
  const validator = ajv.getSchema(schemaId);
  if (!validator) {
    throw new Error(`Contract schema is not registered: ${contractName}`);
  }

  validators.set(contractName, validator);
  return validator;
}

export function validateContract(
  contractName: ContractName,
  value: unknown,
): ContractValidationResult {
  const validator = getValidator(contractName);
  const valid = validator(value);

  return {
    valid,
    errors: validator.errors ? [...validator.errors] : [],
  };
}

export function assertContract(contractName: ContractName, value: unknown): void {
  const result = validateContract(contractName, value);
  if (!result.valid) {
    const details = result.errors
      .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
      .join("; ");
    throw new TypeError(`${contractName} validation failed: ${details}`);
  }
}
