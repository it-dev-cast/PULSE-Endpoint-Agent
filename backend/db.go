package main

import (
	"database/sql"
	_ "embed"
	"fmt"
	"strconv"
	"strings"
	"time"

	_ "github.com/lib/pq"
)

//go:embed schema.sql
var schemaSQL string

// DB wraps *sql.DB and rewrites ? placeholders to PostgreSQL $1, $2, ... so query
// strings across this package stay in the same shape they used under SQLite.
type DB struct {
	*sql.DB
}

func rebind(query string) string {
	n := 0
	var b strings.Builder
	b.Grow(len(query) + 16)
	for i := 0; i < len(query); i++ {
		if query[i] == '?' {
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
		} else {
			b.WriteByte(query[i])
		}
	}
	return b.String()
}

func (d *DB) Exec(query string, args ...any) (sql.Result, error) {
	return d.DB.Exec(rebind(query), args...)
}

func (d *DB) Query(query string, args ...any) (*sql.Rows, error) {
	return d.DB.Query(rebind(query), args...)
}

func (d *DB) QueryRow(query string, args ...any) *sql.Row {
	return d.DB.QueryRow(rebind(query), args...)
}

func openDB(databaseURL string) (*DB, error) {
	raw, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	raw.SetMaxOpenConns(10)
	raw.SetMaxIdleConns(5)
	raw.SetConnMaxLifetime(30 * time.Minute)
	if err := raw.Ping(); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &DB{raw}, nil
}

func runMigrations(db *DB) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin migration transaction: %w", err)
	}
	defer tx.Rollback()

	for _, stmt := range splitSQLStatements(schemaSQL) {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("exec migration statement (%.60s...): %w", stmt, err)
		}
	}

	return tx.Commit()
}

// splitSQLStatements strips "--" line comments before splitting on ";" - splitting the raw
// text directly was tried first and broke on a real run: an ordinary English semicolon inside
// one of this file's own explanatory comments was misread as a statement terminator, which
// mangled both the comment and the INSERT that followed it. Comments can legitimately contain
// semicolons (they're just prose); only semicolons outside a comment ever end a statement.
func splitSQLStatements(sqlText string) []string {
	var withoutComments strings.Builder
	for _, line := range strings.Split(sqlText, "\n") {
		if idx := strings.Index(line, "--"); idx >= 0 {
			line = line[:idx]
		}
		withoutComments.WriteString(line)
		withoutComments.WriteByte('\n')
	}

	raw := strings.Split(withoutComments.String(), ";")
	stmts := make([]string, 0, len(raw))
	for _, s := range raw {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		stmts = append(stmts, s)
	}
	return stmts
}

// fixRemoteCommandExecutionColumnType repairs a real, live-caught bug: tenants.
// remote_command_execution_enabled originally shipped as INTEGER, but is read/written throughout
// this codebase as a Go bool (see settings.go) - a parameterized UPDATE with a bool argument
// against an INTEGER column fails at the database level (confirmed directly; the GET path's
// integer-into-bool Scan tolerates it, the write does not). schema.sql's own ADD COLUMN IF NOT
// EXISTS now declares BOOLEAN for a fresh install, but can't repair an already-migrated database
// where the column exists as INTEGER - and the natural fix (a conditional PL/pgSQL DO block)
// can't live in schema.sql at all, since splitSQLStatements above has no awareness of
// dollar-quoted bodies and shreds any block needing an internal "END IF;"/"END;" terminator
// (confirmed directly - this broke startup entirely the first time). Run once after
// runMigrations, in Go, where a normal conditional and two independent statements are actually
// available. Only ever alters when genuinely needed (checked first), so this is cheap and
// harmless to run on every startup rather than needing to be removed after one use.
func fixRemoteCommandExecutionColumnType(db *DB) error {
	var dataType string
	err := db.QueryRow(
		`SELECT data_type FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'remote_command_execution_enabled'`,
	).Scan(&dataType)
	if err == sql.ErrNoRows {
		return nil // column doesn't exist yet somehow - runMigrations already would have failed first
	}
	if err != nil {
		return fmt.Errorf("check remote_command_execution_enabled column type: %w", err)
	}
	if dataType == "boolean" {
		return nil
	}
	// The existing INTEGER default has to go first - confirmed directly, Postgres refuses TYPE
	// BOOLEAN on a column with a DEFAULT it can't auto-cast (a plain integer literal isn't one),
	// even with USING telling it how to convert the column's actual DATA.
	if _, err := db.Exec(`ALTER TABLE tenants ALTER COLUMN remote_command_execution_enabled DROP DEFAULT`); err != nil {
		return fmt.Errorf("drop remote_command_execution_enabled default: %w", err)
	}
	if _, err := db.Exec(`ALTER TABLE tenants ALTER COLUMN remote_command_execution_enabled TYPE BOOLEAN USING (remote_command_execution_enabled::integer <> 0)`); err != nil {
		return fmt.Errorf("convert remote_command_execution_enabled to boolean: %w", err)
	}
	if _, err := db.Exec(`ALTER TABLE tenants ALTER COLUMN remote_command_execution_enabled SET DEFAULT false`); err != nil {
		return fmt.Errorf("reset remote_command_execution_enabled default: %w", err)
	}
	return nil
}
