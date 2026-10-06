# frozen_string_literal: true

# Conductor RUN — starts this workspace's server (`node server.js`) on this
# workspace's port / database / profile / uploads. The process is supervised:
# INT/TERM/HUP from Conductor are forwarded as TERM, which server.js handles
# gracefully (closes live sessions, the browser and the DB pool).

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

  puts "🚀 Starting #{APP_NAME} (Conductor workspace #{workspace_name})"
  puts "   database : #{db_name}"
  puts "   open     : #{dev_url(web)}"
  puts ''

  ensure_infra!
  ensure_database!
  unless Dir.exist?(File.join(workspace_root, 'node_modules'))
    error_exit('node_modules missing.', 'Run the Setup script first (or `npm ci`).')
  end

  app_env(web).each { |k, v| ENV[k] = v }
  puts "▶️  web -> #{dev_url(web)}"
  puts ''
  start_and_supervise('web' => ['node', 'server.js'])
end

# Spawn all processes, forward termination to the whole group, and exit as soon
# as any one dies (so a crashed server doesn't leave zombies behind).
def start_and_supervise(procs)
  pids = {}
  procs.each { |name, cmd| pids[spawn(*cmd)] = name }

  stopping = false
  stop = lambda do
    next if stopping

    stopping = true
    pids.each_key { |pid| Process.kill('TERM', pid) rescue nil }
  end
  %w[INT TERM HUP].each { |sig| Signal.trap(sig) { stop.call } }

  dead, status = Process.wait2
  warn "⚠️  Process '#{pids[dead] || dead}' exited (#{status.exitstatus || status}) — shutting the rest down." unless stopping
  stop.call
  pids.each_key { |pid| Process.wait(pid) rescue nil }
end

main
