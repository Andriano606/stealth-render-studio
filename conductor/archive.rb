# frozen_string_literal: true

# Conductor ARCHIVE — runs just before a workspace is removed. Conductor deletes
# the worktree itself (node_modules, profile.json, uploads/ go with it); we only
# clean up the EXTERNAL per-workspace state: the Postgres database and the
# port-index reservation. The shared Docker stack is left running for the other
# workspaces. Best-effort: warn, never abort.
#
# Opt-in: CONDUCTOR_KEEP_DB=1 keeps the database (e.g. to seed another
# workspace from it later with CONDUCTOR_SEED_FROM).

require_relative 'conductor_helpers'

$stdout.sync = true
$stderr.sync = true
include ConductorHelpers

def main
  ensure_asdf_shims_on_path!
  Dir.chdir(workspace_root) if Dir.exist?(workspace_root)

  puts "📦 Archiving #{APP_NAME} Conductor workspace #{workspace_name}"
  puts "   database : #{db_name}"
  puts ''

  if ENV['CONDUCTOR_KEEP_DB'] == '1'
    puts "ℹ️  Keeping #{db_name} (CONDUCTOR_KEEP_DB=1)."
  else
    drop_database(db_name)
  end
  release_index!

  puts ''
  puts '✅ Per-workspace resources cleaned up (shared Docker stack left running).'
end

main
