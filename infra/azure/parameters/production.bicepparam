// ATTENDANCE PROJECT — production parameters
//
// NO SECRETS IN THIS FILE.
//
// The administrator password is read from the environment at build time, so the
// value lives in your shell (or the pipeline's secret store) and never in git:
//
//   export ATTENDANCE_PG_ADMIN_PASSWORD="$(openssl rand -base64 32)"
//   az deployment group create ...
//
// Anything written literally here would be committed, and a deployment's
// parameters stay readable by anyone with Reader on the resource group.

using '../main.bicep'

param location = 'centralindia'
param namePrefix = 'attendance-prod'

param postgresAdministratorPassword = readEnvironmentVariable('ATTENDANCE_PG_ADMIN_PASSWORD', '')

// Globally unique names, availability confirmed 2026-09-18.
//
// NOT `attendance-prod-kv`: that name is already taken in Key Vault's GLOBAL
// namespace by a vault outside this tenant (checkNameAvailability →
// AlreadyExists, and `az keyvault list-deleted` is empty here, so it is not a
// soft-deleted vault of ours to purge). Someone else's name is not ours to
// reclaim. `kv-attendance-prod` is taken too — it is a crowded namespace.
param keyVaultName = 'attendance-prod-keyvault'
param registryName = 'attendanceprodacr'
param storageAccountName = 'attendanceprodsa'
param postgresServerName = 'attendance-prod-psql'

param postgresAdministratorLogin = 'attendance_admin'
param postgresVersion = '17'
// `Standard_D2s_v3`, not `GP_Standard_D2s_v3`. The `GP_`/`B_`/`MO_` prefix is an
// Azure *CLI* convention; the ARM API takes the bare VM size and reads the tier
// from postgresSkuTier below. The prefixed form fails the whole deployment with
// ParameterOutOfRange. Identical machine either way: 2 vCore / 8 GiB.
param postgresSkuName = 'Standard_D2s_v3'
param postgresSkuTier = 'GeneralPurpose'
param postgresBackupRetentionDays = 14

// Left Disabled pending confirmation of what HA mode Central India actually
// offers — the capability API reports ZoneRedundantHa=Disabled but
// ZoneRedundantHaAndGeoBackup=Enabled, which is contradictory. Do not promise
// HA in a runbook until this is resolved against a real server.
param postgresHighAvailabilityMode = 'Disabled'

// Phase E provisions infrastructure only. Real images and Key Vault-backed
// secrets arrive in Phase G, after explicit approval.
param webImage = 'mcr.microsoft.com/k8se/quickstart:latest'
param faceAiImage = 'mcr.microsoft.com/k8se/quickstart:latest'
param migrateImage = 'mcr.microsoft.com/k8se/quickstart:latest'
param enableKeyVaultSecretRefs = false

// "mock" is the only backend whose weights are licence-cleared, because it has
// none. See docs/adr/0006 and services/face-ai/app/models/LICENSING.md.
param faceModelBackend = 'mock'

param captureRetentionDays = 30

// Identical to the tags applied to the resource group itself, so a resource
// can never be ambiguous about which project owns it.
param tags = {
  Project: 'Attendance'
  Environment: 'Production'
  ManagedBy: 'Bicep'
  Application: 'Attendance'
  Owner: 'QUBRIX'
  Repository: 'attendance-platform'
}
