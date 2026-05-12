import java.sql.*;
import java.util.*;
import java.io.*;

public class ReadOdb {
    public static void main(String[] args) throws Exception {
        // Force UTF-8 output so Windows CP1252 doesn't mangle accents/ñ
        System.setOut(new PrintStream(System.out, true, "UTF-8"));
        System.setErr(new PrintStream(System.err, true, "UTF-8"));

        if (args.length < 1) {
            System.err.println("Usage: java ReadOdb <path_to_db_prefix>");
            System.exit(1);
        }

        String dbPrefix = args[0];
        String url = "jdbc:hsqldb:file:" + dbPrefix + ";shutdown=true";

        try {
            Class.forName("org.hsqldb.jdbcDriver");
        } catch (ClassNotFoundException e) {
            System.err.println("Could not load HSQLDB driver: " + e.getMessage());
            System.exit(1);
        }

        try (Connection conn = DriverManager.getConnection(url, "SA", "")) {
            DatabaseMetaData metaData = conn.getMetaData();
            
            List<String> tableNames = new ArrayList<>();
            try (ResultSet tables = metaData.getTables(null, null, "%", new String[]{"TABLE"})) {
                while (tables.next()) {
                    tableNames.add(tables.getString("TABLE_NAME"));
                }
            }

            System.out.print("[");
            boolean firstRecord = true;
            
            for (String tableName : tableNames) {
                try (Statement stmt = conn.createStatement();
                     ResultSet rs = stmt.executeQuery("SELECT * FROM \"" + tableName + "\"")) {
                    
                    ResultSetMetaData rsMeta = rs.getMetaData();
                    int columnCount = rsMeta.getColumnCount();
                    
                    while (rs.next()) {
                        if (!firstRecord) System.out.print(",");
                        firstRecord = false;
                        
                        System.out.print("{\"table\":\"" + escapeJson(tableName) + "\",\"data\":{");
                        boolean firstCol = true;
                        for (int i = 1; i <= columnCount; i++) {
                            String colName = rsMeta.getColumnName(i);
                            Object val = rs.getObject(i);
                            if (val != null) {
                                if (!firstCol) System.out.print(",");
                                firstCol = false;
                                System.out.print("\"" + escapeJson(colName) + "\":\"" + escapeJson(val.toString()) + "\"");
                            }
                        }
                        System.out.print("}}");
                    }
                }
            }
            System.out.println("]");
            
        } catch (SQLException e) {
            System.err.println("Database error: " + e.getMessage());
            e.printStackTrace();
            System.exit(1);
        }
    }

    private static String escapeJson(String str) {
        if (str == null) return "";
        return str.replace("\\", "\\\\")
                  .replace("\"", "\\\"")
                  .replace("\b", "\\b")
                  .replace("\f", "\\f")
                  .replace("\n", "\\n")
                  .replace("\r", "\\r")
                  .replace("\t", "\\t");
    }
}
