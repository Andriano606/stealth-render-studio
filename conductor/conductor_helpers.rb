# frozen_string_literal: true

# Shared helpers for the Stealth Render Studio Conductor lifecycle scripts
# (setup.rb / run.rb / archive.rb). Same shape as the taxmate / parting-pro
# conductor scripts, adapted to this stack: Node 20 (asdf) / Express /
# Playwright (Chrome + Camoufox) / PostgreSQL. No Redis, no object storage.
#
# Design rules (see CLAUDE.md):
#   * Never modify the main app at CONDUCTOR_ROOT_PATH. This folder is committed
#     in the app repo, but Conductor runs it from the main checkout by absolute path.
#   * Leave NO git-visible change in a workspace. Per-workspace config is
#     injected as ENV at launch (the app reads PORT / DATABASE_URL /
#     PROFILE_FILE / UPLOAD_DIR in lib/config.js). Files we do write
#     (node_modules, profile.json, uploads/) are gitignored by the app.
#   * Never touch shared global state. One shared Postgres container serves all
#     workspaces; isolation is per-workspace: own DB, own port, own profile/uploads.

require 'socket'
require 'fileutils'
require 'open3'

module ConductorHelpers
  module_function

  APP_NAME = 'Stealth Render Studio'

  # --- shared infrastructure (see docker-compose.yml) -----------------------
  HOST         = '127.0.0.1'
  PG_CONTAINER = 'stealth-cdt-postgres'
  PG_HOST_PORT = 5437          # 5432/5433/5436 already used on this machine
  PG_USER      = 'stealth'
  PG_PASSWORD  = 'stealth'
  WEB_BASE     = 3201          # fallback when CONDUCTOR_PORT is unset (3000 = main checkout)
  MAX_INDEX    = 100

  # --- paths ----------------------------------------------------------------
  # The MAIN checkout. The scripts may run from a workspace's own copy (the .sh
  # wrappers delegate to it), so without CONDUCTOR_ROOT_PATH ask git for the
  # repo every worktree shares instead of assuming "parent of this folder".
  def root_path
    p = ENV['CONDUCTOR_ROOT_PATH'].to_s
    return p unless p.empty?

    @root_path ||= begin
      out, st = Open3.capture2('git', '-C', __dir__, 'rev-parse', '--path-format=absolute', '--git-common-dir')
      st.success? && !out.strip.empty? ? File.dirname(out.strip) : File.expand_path('..', __dir__)
    end
  end

  def workspace_root
    p = ENV['CONDUCTOR_WORKSPACE_PATH'].to_s
    p.empty? ? Dir.pwd : p
  end

  def conductor_dir
    __dir__
  end

  # Shared by ALL workspaces (port index registry, import bundle): always the
  # main checkout's conductor/.state, whichever copy of the scripts is running.
  def state_dir
    dir = File.join(root_path, 'conductor', '.state')
    FileUtils.mkdir_p(dir)
    dir
  end

  def compose_file
    File.join(conductor_dir, 'docker-compose.yml')
  end

  # Gitignored by the app (.gitignore: profile.json, uploads/).
  def profile_file
    File.join(workspace_root, 'profile.json')
  end

  def upload_dir
    File.join(workspace_root, 'uploads')
  end

  # 📦 Bundle (presets + scenarios + step files) imported into every NEW workspace DB.
  # Lives in the main checkout's gitignored conductor/.state/ (it may hold typed form
  # text and attached files), override with CONDUCTOR_IMPORT_BUNDLE=<path>.
  def import_bundle_path
    p = ENV['CONDUCTOR_IMPORT_BUNDLE'].to_s
    p.empty? ? File.join(state_dir, 'import-bundle.json') : File.expand_path(p)
  end

  # --- identity / naming ----------------------------------------------------
  def workspace_name
    n = ENV['CONDUCTOR_WORKSPACE_NAME'].to_s
    n.empty? ? File.basename(workspace_root) : n
  end

  # Postgres-safe slug: lowercase, non-alnum -> "_", trimmed, length-capped.
  def slugify(name)
    s = name.to_s.downcase.gsub(/[^a-z0-9]+/, '_').gsub(/\A_+|_+\z/, '')
    s = 'local' if s.empty?
    s[0, 40]
  end

  def workspace_slug
    slugify(workspace_name)
  end

  def db_name(slug = workspace_slug)
    "stealth_dev_#{slug}"
  end

  # --- per-workspace index registry (conductor_dir/.state/<slug>.port) ------
  def state_file
    File.join(state_dir, "#{workspace_slug}.port")
  end

  def claim_index!
    existing = File.exist?(state_file) ? File.read(state_file).strip : ''
    return existing.to_i unless existing.empty?

    taken = Dir.glob(File.join(state_dir, '*.port'))
               .reject { |f| f == state_file }
               .map { |f| File.read(f).strip.to_i }
    free = (0..MAX_INDEX).find { |n| !taken.include?(n) }
    error_exit("All workspace indexes 0..#{MAX_INDEX} are claimed; archive an unused workspace.") unless free
    File.write(state_file, free.to_s)
    free
  end

  def current_index
    return nil unless File.exist?(state_file)

    v = File.read(state_file).strip
    v.empty? ? nil : v.to_i
  end

  def release_index!
    FileUtils.rm_f(state_file)
  end

  # --- ports ----------------------------------------------------------------
  # Web port: Conductor's assigned CONDUCTOR_PORT if present, else first free
  # port at/after WEB_BASE + index.
  def web_port(index)
    cp = ENV['CONDUCTOR_PORT'].to_i
    cp.positive? ? cp : free_port(WEB_BASE + index)
  end

  def free_port(preferred)
    port = preferred
    loop do
      TCPServer.new(HOST, port).close
      return port
    rescue Errno::EADDRINUSE, Errno::EACCES
      port += 1
    end
  end

  def dev_url(port)
    "http://localhost:#{port}"
  end

  # --- toolchain (asdf) -----------------------------------------------------
  # The app pins Node in a TRACKED .tool-versions, so a worktree already carries
  # it — we only need asdf shims on PATH. We never write .tool-versions.
  def ensure_asdf_shims_on_path!
    parts = ENV['PATH'].to_s.split(File::PATH_SEPARATOR)
    front = []
    %w[shims bin].each do |sub|
      dir = File.join(Dir.home, '.asdf', sub)
      next unless Dir.exist?(dir)

      parts.delete(dir)
      front << dir
    end
    ENV['PATH'] = (front + parts).join(File::PATH_SEPARATOR)
  end

  # Install the Node version the workspace's .tool-versions asks for, if missing
  # (idempotent). Only `nodejs` — the wrapper selects Ruby via ASDF_RUBY_VERSION.
  def ensure_node!
    tv = File.join(workspace_root, '.tool-versions')
    return unless File.exist?(tv)

    version = File.read(tv)[/^nodejs\s+(\S+)/, 1]
    return unless version
    return if Dir.exist?(File.join(Dir.home, '.asdf', 'installs', 'nodejs', version))

    puts "🔧 asdf install nodejs #{version} (from .tool-versions)..."
    system!('asdf', 'install', 'nodejs', version)
  end

  # camoufox-js installs into userCacheDir('camoufox') (shared per user, not
  # per workspace) and writes version.json last.
  def camoufox_installed?
    cache = ENV['XDG_CACHE_HOME'].to_s
    cache = File.join(Dir.home, '.cache') if cache.empty?
    File.exist?(File.join(cache, 'camoufox', 'version.json'))
  end

  # --- per-workspace ENV (injected, never written to disk) ------------------
  def database_url(name = db_name)
    "postgres://#{PG_USER}:#{PG_PASSWORD}@#{HOST}:#{PG_HOST_PORT}/#{name}"
  end

  # Everything lib/config.js reads. HOST stays at the app default (127.0.0.1).
  def app_env(port)
    {
      'PORT' => port.to_s,
      'DATABASE_URL' => database_url,
      'PROFILE_FILE' => profile_file,
      'UPLOAD_DIR' => upload_dir
    }
  end

  # --- docker / postgres ----------------------------------------------------
  def compose_up!
    error_exit("Compose file not found: #{compose_file}") unless File.exist?(compose_file)

    puts '🐳 Bringing up shared infrastructure (Postgres)...'
    system!('docker', 'compose', '-f', compose_file, 'up', '-d')
  end

  def wait_for_pg_ready!(timeout: 120)
    print "⏳ Waiting for Postgres (#{HOST}:#{PG_HOST_PORT}) "
    deadline = Time.now + timeout
    loop do
      ok = system('docker', 'exec', PG_CONTAINER, 'pg_isready', '-h', '127.0.0.1', '-U', PG_USER,
                  out: File::NULL, err: File::NULL)
      if ok
        puts ' ready ✅'
        return
      end
      error_exit('Postgres did not become ready in time.') if Time.now > deadline

      print '.'
      sleep 2
    end
  end

  def ensure_infra!
    compose_up!
    wait_for_pg_ready!
  end

  def psql(sql, db: 'postgres')
    Open3.capture3('docker', 'exec', '-e', "PGPASSWORD=#{PG_PASSWORD}", PG_CONTAINER,
                   'psql', '-U', PG_USER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAc', sql)
  end

  def database_exists?(name)
    out, _e, st = psql("SELECT 1 FROM pg_database WHERE datname='#{name}'")
    st.success? && out.strip == '1'
  end

  # Creates the empty workspace DB. Tables are created by the app itself on
  # startup (lib/db.js initDb: CREATE TABLE IF NOT EXISTS ...).
  def ensure_database!(name = db_name)
    if database_exists?(name)
      puts "✅ Database exists: #{name}"
      return false
    end

    _o, err, st = psql("CREATE DATABASE \"#{name}\"")
    error_exit("Could not create database #{name}: #{err.strip}") unless st.success?
    puts "✅ Created database #{name}"
    true
  end

  # Copy another workspace's DB (scenarios, presets) into this one: pg_dump |
  # psql inside the shared container (no lock on the source, unlike TEMPLATE).
  def seed_database_from!(source_workspace)
    src = db_name(slugify(source_workspace))
    error_exit("Seed source database #{src} does not exist.") unless database_exists?(src)

    puts "🌱 Seeding #{db_name} from #{src}..."
    cmd = "pg_dump -U #{PG_USER} --no-owner --no-acl #{src} | psql -q -U #{PG_USER} -d #{db_name} -v ON_ERROR_STOP=1"
    system!('docker', 'exec', '-e', "PGPASSWORD=#{PG_PASSWORD}", PG_CONTAINER, 'sh', '-c', cmd)
  end

  def drop_database(name)
    _o, _e, st = psql("DROP DATABASE IF EXISTS \"#{name}\" WITH (FORCE)")
    puts(st.success? ? "✅ Dropped #{name}" : "⚠️  Could not drop #{name} (Postgres down or already gone).")
  end

  # --- git hygiene ----------------------------------------------------------
  def git_ignored?(path)
    system('git', '-C', workspace_root, 'check-ignore', '-q', path)
  end

  # The core rule guard: a set-up workspace must look clean to git.
  def verify_git_clean!
    out, _e, st = Open3.capture3('git', '-C', workspace_root, 'status', '--porcelain')
    return unless st.success?

    if out.strip.empty?
      puts '✅ Workspace is git-clean'
    else
      warn '⚠️  Workspace has git-visible changes after setup — investigate:'
      warn out
    end
  end

  # --- shell plumbing -------------------------------------------------------
  def system!(*args)
    system(*args) || error_exit("Command failed: #{printable(args)}")
  end

  def retry_system!(*args, attempts: 3, sleep_seconds: 3)
    attempts.times do |i|
      return if system(*args)

      warn "   attempt #{i + 1}/#{attempts} failed; retrying in #{sleep_seconds}s..."
      sleep sleep_seconds
    end
    error_exit("Command failed after #{attempts} attempts: #{printable(args)}")
  end

  def printable(args)
    args.reject { |a| a.is_a?(Hash) }.join(' ')
  end

  def error_exit(message, hint = nil)
    warn "❌ #{message}"
    warn "   #{hint}" if hint
    exit 1
  end
end
