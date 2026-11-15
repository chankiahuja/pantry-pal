package com.pantrypal;

import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class PostgresCiDatabaseGuardTest {
    @Autowired DataSource dataSource;

    @Test
    void selectedVerificationTestsUsePostgresql() throws Exception {
        try (var connection = dataSource.getConnection()) {
            assertThat(connection.getMetaData().getDatabaseProductName()).contains("PostgreSQL");
            assertThat(connection.getMetaData().getURL()).startsWith("jdbc:postgresql:");
        }
    }
}
