package dev.elide.inspector;

import android.database.Cursor;
import android.database.DatabaseErrorHandler;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import android.os.Build;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.PrintStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * One long-lived session per open explorer, running as the selected app UID. The host writes one JSON request per
 * line and reads exactly one JSON response line per request, echoing its {@code id}; the first line announces the
 * protocol and this process's PID. End of input ends the session.
 */
public final class DatabaseInspector {
    private static final int PROTOCOL = 2;
    private static final int MAX_INPUT = 512 * 1024;
    private static final int MAX_SQL = 64 * 1024;
    private static final int MAX_OUTPUT = 4 * 1024 * 1024;
    private static final int MAX_CELL = 256 * 1024;
    private static final int MAX_COLUMNS = 256;
    private static final int MAX_FILES = 4096;
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static final byte[] SQLITE_HEADER = "SQLite format 3\u0000".getBytes(StandardCharsets.US_ASCII);
    private static final String[] READS = {"SELECT", "WITH", "EXPLAIN"};
    private static final String[] WRITES = {"INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "ALTER", "DROP", "WITH"};
    // Android's default corruption handler deletes database files, even on a failed open.
    private static final DatabaseErrorHandler CORRUPTION_HANDLER = new DatabaseErrorHandler() {
        @Override
        public void onCorruption(SQLiteDatabase database) {
            throw new SQLiteException("Database corruption detected; inspector will not repair or delete app data.");
        }
    };

    private DatabaseInspector() {}

    public static void main(String[] args) {
        // Only protocol lines may reach stdout; anything a framework class prints goes to stderr instead.
        PrintStream protocol = System.out;
        System.setOut(System.err);
        InputStream input = new BufferedInputStream(System.in, 64 * 1024);
        try {
            JSONObject hello = new JSONObject().put("ready", true).put("protocol", PROTOCOL)
                    .put("pid", android.os.Process.myPid());
            if (!write(protocol, hello.toString().getBytes(StandardCharsets.UTF_8))) return;
        } catch (Exception impossible) {
            return;
        }
        while (true) {
            byte[] line;
            try {
                line = readLine(input);
            } catch (Exception exception) {
                // An oversized or unreadable request cannot be resynchronized: answer once and end the session.
                write(protocol, errorResponse(exception, JSONObject.NULL));
                return;
            }
            if (line == null) return;
            Object id = JSONObject.NULL;
            byte[] response;
            try {
                JSONObject request = decodeRequest(line);
                id = request.opt("id");
                if (!(id instanceof Number)) {
                    id = JSONObject.NULL;
                    throw new IllegalArgumentException("Request id must be a number.");
                }
                JSONObject result = dispatch(request);
                result.put("ok", true).put("id", id);
                response = encodeResponse(result);
            } catch (Exception exception) {
                response = errorResponse(exception, id);
            }
            // The host may have cancelled the request and closed its pipe.
            if (!write(protocol, response)) return;
        }
    }

    private static boolean write(PrintStream protocol, byte[] line) {
        protocol.write(line, 0, line.length);
        protocol.write('\n');
        protocol.flush();
        return !protocol.checkError();
    }

    /** One request line without its newline; null at end of input. */
    private static byte[] readLine(InputStream input) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int next;
        while ((next = input.read()) != -1) {
            if (next == '\n') return bytes.toByteArray();
            if (bytes.size() >= MAX_INPUT) throw new IllegalArgumentException("Request exceeds 512 KiB.");
            bytes.write(next);
        }
        return bytes.size() == 0 ? null : bytes.toByteArray();
    }

    private static JSONObject decodeRequest(byte[] bytes) throws Exception {
        String json = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString();
        return new JSONObject(json);
    }

    private static JSONObject dispatch(JSONObject request) throws Exception {
        String action = string(request, "action");
        if ("databases".equals(action)) {
            File root = databaseRoot();
            JSONArray databases = new JSONArray();
            if (root.exists()) {
                if (!root.isDirectory()) throw new IllegalArgumentException("databases is not a directory.");
                enumerate(root, root, databases, new HashSet<String>(), new int[] {0}, 0);
            }
            return new JSONObject().put("databases", databases);
        }
        if (!"schema".equals(action) && !"query".equals(action) && !"execute".equals(action)) {
            throw new IllegalArgumentException("Unknown action: " + action);
        }
        File database = resolveDatabase(string(request, "database"));
        if ("schema".equals(action)) return schema(database);
        String sql = string(request, "sql");
        String keyword = validateSql(sql);
        if ("query".equals(action)) {
            if (!oneOf(keyword, READS)) {
                throw new IllegalArgumentException(oneOf(keyword, WRITES)
                        ? "Run read-only query accepts SELECT, WITH or EXPLAIN; use Execute write… for " + keyword + "."
                        : unsupported(keyword));
            }
            int limit = integer(request, "limit", 1, 500);
            int offset = integer(request, "offset", 0, 1000000);
            return query(database, sql, limit, offset);
        }
        if (!oneOf(keyword, WRITES)) {
            throw new IllegalArgumentException(oneOf(keyword, READS)
                    ? "Execute write… accepts INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER, DROP or WITH; use Run read-only query for " + keyword + "."
                    : unsupported(keyword));
        }
        return execute(database, sql);
    }

    private static File databaseRoot() throws Exception {
        File appRoot = new File(".").getCanonicalFile();
        File expected = new File(appRoot, "databases");
        File actual = expected.getCanonicalFile();
        if (!actual.equals(expected)) {
            throw new IllegalArgumentException("The databases directory must not be a symbolic link.");
        }
        return actual;
    }

    private static File resolveDatabase(String name) throws Exception {
        if (name.isEmpty() || name.indexOf('\u0000') >= 0 || name.indexOf('\\') >= 0
                || new File(name).isAbsolute()) {
            throw new IllegalArgumentException("Database must be a relative path inside databases/.");
        }
        for (String part : name.split("/", -1)) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) {
                throw new IllegalArgumentException("Database path traversal is not allowed.");
            }
        }
        File root = databaseRoot();
        File file = new File(root, name).getCanonicalFile();
        requireContained(root, file);
        if (!file.isFile() || !isDatabase(file)) {
            throw new IllegalArgumentException("Database does not exist or has no SQLite header: " + name);
        }
        return file;
    }

    private static void requireContained(File root, File file) {
        if (!file.getPath().startsWith(root.getPath() + File.separator)) {
            throw new IllegalArgumentException("Database path escapes databases/ (including symbolic links).");
        }
    }

    private static boolean isDatabase(File file) throws Exception {
        String name = file.getName();
        if (name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith("-journal")) return false;
        byte[] header = new byte[SQLITE_HEADER.length];
        try (FileInputStream stream = new FileInputStream(file)) {
            int read = 0;
            while (read < header.length) {
                int count = stream.read(header, read, header.length - read);
                if (count < 0) return false;
                read += count;
            }
        }
        return Arrays.equals(header, SQLITE_HEADER);
    }

    private static void enumerate(File root, File directory, JSONArray result,
            Set<String> visited, int[] count, int depth) throws Exception {
        if (depth > 16) throw new IllegalArgumentException("Database directory nesting exceeds 16 levels.");
        if (!visited.add(directory.getCanonicalPath())) return;
        File[] children = directory.listFiles();
        if (children == null) throw new IllegalArgumentException("Cannot read database directory.");
        Arrays.sort(children);
        for (File child : children) {
            if (++count[0] > MAX_FILES) throw new IllegalArgumentException("Database discovery exceeds 4096 filesystem entries.");
            File canonical = child.getCanonicalFile();
            requireContained(root, canonical);
            if (canonical.isDirectory()) {
                enumerate(root, canonical, result, visited, count, depth + 1);
            } else if (canonical.isFile() && isDatabase(canonical)) {
                result.put(canonical.getPath().substring(root.getPath().length() + 1));
            }
        }
    }

    private static SQLiteDatabase openReadOnly(File file) {
        SQLiteDatabase database = SQLiteDatabase.openDatabase(file.getPath(), null,
                SQLiteDatabase.OPEN_READONLY, CORRUPTION_HANDLER);
        try {
            database.execSQL("PRAGMA query_only=ON");
            return database;
        } catch (RuntimeException exception) {
            database.close();
            throw exception;
        }
    }

    private static JSONObject schema(File file) throws Exception {
        JSONArray objects = new JSONArray();
        int budget = 128;
        try (SQLiteDatabase database = openReadOnly(file);
                Cursor cursor = database.rawQuery("SELECT name,type,sql FROM sqlite_master "
                        + "WHERE type IN ('table','view','index','trigger') ORDER BY type,name", null)) {
            while (cursor.moveToNext()) {
                JSONObject object = new JSONObject().put("name", boundedText(cursor.getString(0)))
                        .put("type", cursor.getString(1))
                        .put("sql", cursor.isNull(2) ? JSONObject.NULL : boundedText(cursor.getString(2)));
                budget = addBudget(budget, object.toString());
                objects.put(object);
            }
        }
        return new JSONObject().put("objects", objects);
    }

    private static JSONObject query(File file, String sql, int limit, int offset) throws Exception {
        JSONArray columns = new JSONArray();
        JSONArray rows = new JSONArray();
        boolean hasMore = false;
        int budget = 128;
        try (SQLiteDatabase database = openReadOnly(file);
                Cursor cursor = database.rawQuery(sql, null)) {
            if (cursor.getColumnCount() > MAX_COLUMNS) {
                throw new IllegalArgumentException("Query exceeds 256 columns.");
            }
            for (String column : cursor.getColumnNames()) columns.put(boundedText(column));
            budget = addBudget(budget, columns.toString());
            // Cursor pagination preserves SQL semantics without interpolating or rewriting it.
            if (cursor.moveToPosition(offset)) {
                do {
                    if (rows.length() == limit) {
                        hasMore = true;
                        break;
                    }
                    JSONArray row = new JSONArray();
                    for (int column = 0; column < cursor.getColumnCount(); column++) {
                        row.put(cell(cursor, column));
                    }
                    budget = addBudget(budget, row.toString());
                    rows.put(row);
                } while (cursor.moveToNext());
            }
        }
        return new JSONObject().put("columns", columns).put("rows", rows).put("hasMore", hasMore);
    }

    private static Object cell(Cursor cursor, int column) throws Exception {
        switch (cursor.getType(column)) {
            case Cursor.FIELD_TYPE_NULL:
                return JSONObject.NULL;
            case Cursor.FIELD_TYPE_INTEGER:
                long value = cursor.getLong(column);
                if (value > MAX_SAFE_INTEGER || value < -MAX_SAFE_INTEGER) {
                    return new JSONObject().put("type", "integer").put("value", Long.toString(value));
                }
                return value;
            case Cursor.FIELD_TYPE_FLOAT:
                double real = cursor.getDouble(column);
                if (Double.isInfinite(real) || Double.isNaN(real)) {
                    throw new IllegalArgumentException("Query returned a non-finite floating-point number that JSON cannot represent.");
                }
                return real;
            case Cursor.FIELD_TYPE_BLOB:
                byte[] bytes = cursor.getBlob(column);
                if (bytes.length > MAX_CELL) throw new IllegalArgumentException("Blob exceeds 256 KiB; select a smaller value explicitly.");
                return new JSONObject().put("type", "blob")
                        .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            case Cursor.FIELD_TYPE_STRING:
                return boundedText(cursor.getString(column));
            default:
                throw new IllegalArgumentException("Unsupported SQLite cell type.");
        }
    }

    private static JSONObject execute(File file, String sql) throws Exception {
        // Determine the existing mode using a genuinely read-only connection. In particular,
        // never open an existing WAL database with Android's default DELETE journal mode.
        String journalMode;
        try (SQLiteDatabase database = openReadOnly(file);
                Cursor cursor = database.rawQuery("PRAGMA journal_mode", null)) {
            if (!cursor.moveToFirst()) throw new IllegalArgumentException("Cannot determine database journal mode.");
            journalMode = cursor.getString(0);
        }
        int flags = SQLiteDatabase.OPEN_READWRITE;
        if ("wal".equalsIgnoreCase(journalMode)) flags |= SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING;
        SQLiteDatabase database;
        if (Build.VERSION.SDK_INT >= 28) {
            database = SQLiteDatabase.openDatabase(file, new SQLiteDatabase.OpenParams.Builder()
                    .setOpenFlags(flags).setJournalMode(journalMode)
                    .setErrorHandler(CORRUPTION_HANDLER).build());
        } else {
            database = SQLiteDatabase.openDatabase(file.getPath(), null, flags, CORRUPTION_HANDLER);
        }
        try (SQLiteDatabase connection = database) {
            connection.setForeignKeyConstraintsEnabled(true);
            connection.beginTransactionNonExclusive();
            long changes;
            try {
                long before = totalChanges(connection);
                connection.execSQL(sql);
                changes = totalChanges(connection) - before;
                connection.setTransactionSuccessful();
            } finally {
                connection.endTransaction();
            }
            return new JSONObject().put("changes", changes);
        }
    }

    private static long totalChanges(SQLiteDatabase database) {
        try (Cursor cursor = database.rawQuery("SELECT total_changes()", null)) {
            if (!cursor.moveToFirst()) throw new IllegalStateException("SQLite did not return a change count.");
            return cursor.getLong(0);
        }
    }

    private static String boundedText(String value) {
        if (value.length() > MAX_CELL || value.getBytes(StandardCharsets.UTF_8).length > MAX_CELL) {
            throw new IllegalArgumentException("Text exceeds 256 KiB; select a smaller value explicitly.");
        }
        return value;
    }

    private static int addBudget(int current, String json) {
        int next = current + json.getBytes(StandardCharsets.UTF_8).length + 1;
        if (next > MAX_OUTPUT - 1) throw new IllegalArgumentException("Response exceeds 4 MiB; request fewer rows or smaller values.");
        return next;
    }

    private static byte[] encodeResponse(JSONObject response) {
        byte[] bytes = response.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length >= MAX_OUTPUT) throw new IllegalArgumentException("Response exceeds 4 MiB; request fewer rows or smaller values.");
        return bytes;
    }

    /** Neither button runs it; say what each does run, and how to read what a PRAGMA reports. */
    private static String unsupported(String keyword) {
        return keyword + " statements are not supported. Run read-only query accepts SELECT, WITH or EXPLAIN; "
                + "Execute write… accepts one INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER, DROP or WITH statement. "
                + "PRAGMA, ATTACH, transaction control and maintenance commands are not available"
                + ("PRAGMA".equals(keyword) ? "; read a PRAGMA through its table-valued function, e.g. "
                        + "SELECT * FROM pragma_table_info('table_name')." : ".");
    }

    private static byte[] errorResponse(Exception exception, Object id) {
        String message = exception.getMessage();
        if (message == null || message.isEmpty()) message = exception.getClass().getSimpleName();
        if (message.length() > 2048) message = message.substring(0, 2048) + " (error detail shortened)";
        try {
            return new JSONObject().put("ok", false).put("id", id).put("error", message).toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception impossible) {
            return "{\"ok\":false,\"error\":\"Could not encode SQLite error.\"}".getBytes(StandardCharsets.UTF_8);
        }
    }

    private static String string(JSONObject request, String key) throws Exception {
        Object value = request.get(key);
        if (!(value instanceof String)) throw new IllegalArgumentException(key + " must be a string.");
        return (String) value;
    }

    private static int integer(JSONObject request, String key, int minimum, int maximum) throws Exception {
        Object value = request.get(key);
        if (!(value instanceof Number)) throw new IllegalArgumentException(key + " must be an integer.");
        double number = ((Number) value).doubleValue();
        if (number < minimum || number > maximum || number != Math.rint(number)) {
            throw new IllegalArgumentException(key + " must be an integer from " + minimum + " through " + maximum + ".");
        }
        return (int) number;
    }

    private static boolean oneOf(String value, String... choices) {
        for (String choice : choices) if (choice.equals(value)) return true;
        return false;
    }

    /** Reject a second statement without mistaking quoted strings/comments for SQL tokens. */
    private static String validateSql(String sql) {
        if (sql.isEmpty() || sql.indexOf('\u0000') >= 0 || sql.getBytes(StandardCharsets.UTF_8).length > MAX_SQL) {
            throw new IllegalArgumentException("SQL must be nonempty, contain no NUL, and be at most 64 KiB UTF-8.");
        }
        String keyword = null;
        boolean terminated = false;
        int index = 0;
        while (index < sql.length()) {
            char c = sql.charAt(index);
            if (Character.isWhitespace(c)) { index++; continue; }
            if (c == '-' && index + 1 < sql.length() && sql.charAt(index + 1) == '-') {
                index += 2;
                while (index < sql.length() && sql.charAt(index) != '\n' && sql.charAt(index) != '\r') index++;
                continue;
            }
            if (c == '/' && index + 1 < sql.length() && sql.charAt(index + 1) == '*') {
                int end = sql.indexOf("*/", index + 2);
                if (end < 0) throw new IllegalArgumentException("SQL contains an unterminated comment.");
                index = end + 2;
                continue;
            }
            if (terminated) throw new IllegalArgumentException("Only one SQL statement is allowed; compound CREATE TRIGGER bodies are not supported.");
            if (c == ';') { terminated = true; index++; continue; }
            if (keyword == null) {
                int start = index;
                while (index < sql.length() && ((sql.charAt(index) >= 'A' && sql.charAt(index) <= 'Z')
                        || (sql.charAt(index) >= 'a' && sql.charAt(index) <= 'z'))) index++;
                if (index == start) throw new IllegalArgumentException("SQL must begin with a supported statement keyword.");
                keyword = sql.substring(start, index).toUpperCase(Locale.ROOT);
                continue;
            }
            if (c == '\'' || c == '"' || c == '`' || c == '[') {
                char endQuote = c == '[' ? ']' : c;
                index++;
                boolean closed = false;
                while (index < sql.length()) {
                    if (sql.charAt(index++) == endQuote) {
                        if (c != '[' && index < sql.length() && sql.charAt(index) == endQuote) { index++; continue; }
                        closed = true;
                        break;
                    }
                }
                if (!closed) throw new IllegalArgumentException("SQL contains an unterminated quoted value or identifier.");
                continue;
            }
            index++;
        }
        if (keyword == null) throw new IllegalArgumentException("SQL contains no statement.");
        return keyword;
    }
}
