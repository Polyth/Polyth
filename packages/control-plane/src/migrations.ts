// Historical migration bytes are immutable; append new versions here.
import { migrations as v1 } from './schema.ts';
import { securityMigration } from './securityMigration.ts';
export const migrations = [...v1, securityMigration];
