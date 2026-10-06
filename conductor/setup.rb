# frozen_string_literal: true

# Conductor SETUP — runs once per new workspace, after git checks out the app.
# Turns the bare worktree into a runnable, isolated dev environment without
# touching the main app and without leaving any git-visible change.
#
# Opt-in env flags:
#   CONDUCTOR_SKIP_DEPS=1          skip `npm ci`
#   CONDUCTOR_SKIP_DB=1            skip database creation
#   CONDUCTOR_SEED_FROM=<ws-name>  fill a NEW workspace DB with a copy of another
#                                  workspace's DB (scenarios, presets)
#   CONDUCTOR_FETCH_CAMOUFOX=1     download the Camoufox binary (~1.3 GB, shared
#                                  per user, once) if it's missing

require_relative 'conductor_helpers'

$stdout.sync = true
$stderr.sync = true
include ConductorHelpers

def main
  ensure_asdf_shims_on_path!
  Dir.chdir(workspace_root)
  ensure_node!

  index = claim_index!
  web = web_port(index)

  puts "🚀 Setting up Conductor workspace for #{APP_NAME}"
  puts "   workspace : #{workspace_name}  (index #{index})"
  puts "   database  : #{db_name}"
  puts "   web port  : #{web}"
  puts ''

  unless ENV['CONDUCTOR_SKIP_DB'] == '1'
    ensure_infra!
    created = ensure_database!
    seed = ENV['CONDUCTOR_SEED_FROM'].to_s
    if !seed.empty? && created
      seed_database_from!(seed)
    elsif !seed.empty?
      puts "ℹ️  CONDUCTOR_SEED_FROM ignored: #{db_name} already existed."
    end
  end

  install_dependencies
  copy_profile
  check_browsers
  check_git_hooks
  verify_git_clean!

  puts ''
  puts '✅ Workspace setup complete!'
  puts "▶️  Click Run, then open: #{dev_url(web)}"
end

def install_dependencies
  return if ENV['CONDUCTOR_SKIP_DEPS'] == '1'

  puts ''
  # `npm ci` (never `npm install`): it can't rewrite the tracked package-lock.json.
  # postinstall auto-patches camoufox-js inside node_modules (gitignored).
  puts '📦 Installing JS packages (npm ci)...'
  retry_system!('npm', 'ci', '--no-audit', '--no-fund')
end

# Carry the main checkout's calibrated browser profile into a fresh workspace
# (profile.json is gitignored by the app). Never overwrite an existing one.
def copy_profile
  src = File.join(root_path, 'profile.json')
  return if File.exist?(profile_file) || !File.exist?(src)
  return if File.expand_path(src) == File.expand_path(profile_file)
  return warn('⚠️  profile.json is not gitignored here — not copying it.') unless git_ignored?(profile_file)

  FileUtils.cp(src, profile_file)
  puts "✅ Copied profile.json from #{root_path}"
end

def check_browsers
  unless system('which', 'google-chrome', out: File::NULL, err: File::NULL)
    warn '⚠️  Google Chrome not found — the Chromium engine uses channel "chrome".'
  end

  if camoufox_installed?
    puts '✅ Camoufox binary present'
  elsif ENV['CONDUCTOR_FETCH_CAMOUFOX'] == '1'
    puts '🦊 Fetching Camoufox binary (~1.3 GB, once per user)...'
    retry_system!('npm', 'run', 'fetch-camoufox')
  else
    puts 'ℹ️  Camoufox binary not installed — Chromium works; for the Camoufox engine re-run setup with ' \
         'CONDUCTOR_FETCH_CAMOUFOX=1 (or `npm run fetch-camoufox` once).'
  end
end

# The app's tests gate commits via .githooks, enabled by a one-time
# `git config core.hooksPath .githooks`. We don't change repo config — just remind.
def check_git_hooks
  out, = Open3.capture2('git', '-C', workspace_root, 'config', '--get', 'core.hooksPath')
  return if out.strip == '.githooks'

  puts 'ℹ️  Test gate hooks are off. Enable once (shared by all worktrees): ' \
       "git -C #{root_path} config core.hooksPath .githooks"
end

main
