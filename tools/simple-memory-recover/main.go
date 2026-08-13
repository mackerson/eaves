// simple-memory-recover: one-time recovery tool.
//
// When Enclave dropped the bundled "simple-memory" plugin in favor of the
// built-in memory store, existing plugin memories were left stranded in the
// plugin_storage table — the app simply stopped reading them. This tool copies
// those memories into the new internal store (memory_entries) so they show up
// again in the app.
//
// It is SAFE by design:
//   - makes a full, consistent backup of the database before touching anything
//   - non-destructive: INSERT OR IGNORE never overwrites or deletes a memory
//     you already have (safe to run twice)
//   - refuses to run if Enclave is still open (the database would be locked)
//
// Usage (Windows): close Enclave, then double-click the .exe.
//   --db <path>   operate on a specific database file (default: your Enclave profile)
//   --dry-run     report what WOULD happen; make no changes
//   --yes         skip the confirmation prompt
//   --no-pause    don't wait for Enter at the end (for scripting)
package main

import (
	"bufio"
	"database/sql"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	_ "modernc.org/sqlite"
)

const pluginID = "com.enclave.simple-memory"

// The transform. simple-memory stored each memory as JSON {value, metadata:{...}},
// which is exactly the shape the internal store uses — so this is a direct copy.
// FTS indexing happens automatically via the memory_entries AFTER INSERT trigger.
// Vector embeddings (if enabled) are backfilled by the app on next launch.
const migrateSQL = `
INSERT OR IGNORE INTO memory_entries (key, value, metadata, agent_id, created_at, updated_at)
SELECT ps.key,
       json_extract(ps.value, '$.value'),
       json_extract(ps.value, '$.metadata'),
       NULL,
       COALESCE(CAST(json_extract(ps.value, '$.metadata.storedAt')  AS INTEGER), ps.created_at),
       COALESCE(CAST(json_extract(ps.value, '$.metadata.updatedAt') AS INTEGER), ps.updated_at)
FROM plugin_storage ps
WHERE ps.plugin_id = ?
  AND json_valid(ps.value)
  AND json_extract(ps.value, '$.value') IS NOT NULL;`

func defaultDBPath() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("APPDATA"), "enclave", "enclave-data", "enclave.db")
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support", "enclave", "enclave-data", "enclave.db")
	default:
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".config", "enclave", "enclave-data", "enclave.db")
	}
}

func main() {
	dbPath := flag.String("db", "", "path to enclave.db (default: your Enclave profile)")
	dryRun := flag.Bool("dry-run", false, "report what would happen; make no changes")
	assumeYes := flag.Bool("yes", false, "skip the confirmation prompt")
	noPause := flag.Bool("no-pause", false, "don't wait for Enter at the end")
	flag.Parse()

	if err := run(*dbPath, *dryRun, *assumeYes); err != nil {
		fmt.Fprintf(os.Stderr, "\nERROR: %v\n", err)
		pause(*noPause, 1)
	}
	pause(*noPause, 0)
}

func run(dbPath string, dryRun, assumeYes bool) error {
	if dbPath == "" {
		dbPath = defaultDBPath()
	}
	fmt.Println("Enclave — simple-memory recovery")
	fmt.Println("================================")
	fmt.Printf("Database: %s\n\n", dbPath)

	if _, err := os.Stat(dbPath); err != nil {
		return fmt.Errorf("database not found at %s\n       Pass --db <path> if your data lives elsewhere.", dbPath)
	}

	// Open read-write with a short busy timeout so a locked DB fails fast and
	// clearly rather than hanging.
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_pragma=busy_timeout(3000)", dbPath))
	if err != nil {
		return fmt.Errorf("cannot open database: %w", err)
	}
	defer db.Close()

	// A locked DB almost always means Enclave is still running.
	if _, err := db.Exec("PRAGMA wal_checkpoint(PASSIVE)"); err != nil {
		return fmt.Errorf("database is busy — is Enclave still open? Close it completely and try again.\n       (%v)", err)
	}

	if err := preflightSchema(db); err != nil {
		return err
	}

	stranded, alreadyPresent, toRecover, err := counts(db)
	if err != nil {
		return err
	}
	existing, _ := scalar(db, "SELECT COUNT(*) FROM memory_entries")

	fmt.Printf("Found %d simple-memory entries in plugin storage.\n", stranded)
	fmt.Printf("Internal store currently holds %d memories.\n", existing)
	fmt.Printf("Already recovered (matching key present): %d\n", alreadyPresent)
	fmt.Printf("To recover now: %d\n\n", toRecover)

	if toRecover == 0 {
		fmt.Println("Nothing to do — your memories are already in the internal store. ✓")
		return nil
	}
	if dryRun {
		fmt.Println("(--dry-run) No changes made.")
		return nil
	}
	if !assumeYes && !confirm(fmt.Sprintf("Recover %d memories now? A backup is made first. [y/N] ", toRecover)) {
		fmt.Println("Cancelled — no changes made.")
		return nil
	}

	// Consistent, single-file backup via VACUUM INTO (folds in any WAL).
	backup := fmt.Sprintf("%s.premigrate-%s.bak", dbPath, time.Now().UTC().Format("20060102T150405Z"))
	fmt.Printf("Backing up to:\n  %s\n", backup)
	if _, err := db.Exec("VACUUM INTO ?", backup); err != nil {
		return fmt.Errorf("backup failed (no changes made): %w", err)
	}

	res, err := db.Exec(migrateSQL, pluginID)
	if err != nil {
		return fmt.Errorf("recovery failed — your data is unchanged; a backup is at %s\n       (%v)", backup, err)
	}
	inserted, _ := res.RowsAffected()

	after, _ := scalar(db, "SELECT COUNT(*) FROM memory_entries")
	ftsCount, _ := scalar(db, "SELECT COUNT(*) FROM memory_fts")
	fmt.Printf("\nRecovered %d memories. ✓\n", inserted)
	fmt.Printf("Internal store now holds %d memories (search index: %d).\n", after, ftsCount)
	fmt.Println("\nOpen Enclave — your memories are back. If semantic search is enabled,")
	fmt.Println("the app will build embeddings for them on next launch.")
	return nil
}

func preflightSchema(db *sql.DB) error {
	if n, _ := scalar(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memory_entries'"); n == 0 {
		return fmt.Errorf("this database predates the internal memory store.\n       Update Enclave to the current version first, then run this tool.")
	}
	if n, _ := scalar(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='plugin_storage'"); n == 0 {
		return fmt.Errorf("no plugin_storage table — nothing to recover from.")
	}
	return nil
}

func counts(db *sql.DB) (stranded, alreadyPresent, toRecover int64, err error) {
	if stranded, err = scalar(db, "SELECT COUNT(*) FROM plugin_storage WHERE plugin_id=?", pluginID); err != nil {
		return
	}
	if alreadyPresent, err = scalar(db,
		"SELECT COUNT(*) FROM plugin_storage ps WHERE ps.plugin_id=? AND EXISTS (SELECT 1 FROM memory_entries me WHERE me.key=ps.key)",
		pluginID); err != nil {
		return
	}
	toRecover, err = scalar(db,
		`SELECT COUNT(*) FROM plugin_storage ps WHERE ps.plugin_id=?
		   AND json_valid(ps.value) AND json_extract(ps.value,'$.value') IS NOT NULL
		   AND NOT EXISTS (SELECT 1 FROM memory_entries me WHERE me.key=ps.key)`, pluginID)
	return
}

func scalar(db *sql.DB, q string, args ...any) (int64, error) {
	var n int64
	err := db.QueryRow(q, args...).Scan(&n)
	return n, err
}

func confirm(prompt string) bool {
	fmt.Print(prompt)
	s, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	return len(s) > 0 && (s[0] == 'y' || s[0] == 'Y')
}

func pause(noPause bool, code int) {
	if !noPause {
		fmt.Print("\nPress Enter to close...")
		bufio.NewReader(os.Stdin).ReadString('\n')
	}
	os.Exit(code)
}
