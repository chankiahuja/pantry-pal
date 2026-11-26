package com.pantrypal;

import javax.sql.DataSource;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;
import com.zaxxer.hikari.HikariDataSource;

/** Selects a non-blank explicit DB_URL while preserving existing Render settings. */
@Configuration(proxyBeanMethods = false)
@Profile("production")
class ProductionDatasourceConfiguration {
    @Bean
    @Primary
    @ConfigurationProperties("spring.datasource.hikari")
    DataSource productionDataSource(Environment environment) {
        return DataSourceBuilder.create()
            .type(HikariDataSource.class)
            .url(resolveUrl(environment))
            .username(required(environment, "DB_USER"))
            .password(required(environment, "DB_PASSWORD"))
            .build();
    }

    static String resolveUrl(Environment environment) {
        String explicitUrl = environment.getProperty("DB_URL");
        if (explicitUrl != null && !explicitUrl.isBlank()) return explicitUrl;

        // Preserve command-line/IDE spring.datasource.url overrides used by tests and operators.
        String configuredUrl = environment.getProperty("spring.datasource.url");
        if (configuredUrl != null && !configuredUrl.isBlank() && !configuredUrl.contains("${")) {
            return configuredUrl;
        }

        return "jdbc:postgresql://"
            + required(environment, "DB_HOST") + ":"
            + required(environment, "DB_PORT") + "/"
            + required(environment, "DB_NAME");
    }

    private static String required(Environment environment, String name) {
        String value = environment.getProperty(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required for the production PostgreSQL datasource.");
        }
        return value;
    }
}
