package com.pantrypal;

import javax.sql.DataSource;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.Environment;
import org.springframework.core.env.PropertySource;
import org.springframework.util.PlaceholderResolutionException;
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
            .username(required(environment, "spring.datasource.username"))
            .password(required(environment, "spring.datasource.password"))
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
        String value;
        try {
            value = environment.getProperty(name);
        } catch (PlaceholderResolutionException exception) {
            value = rawProperty(environment, name);
            if (value == null || isEntirePlaceholder(value)) {
                throw missingProperty(name);
            }
        }
        if (value == null || value.isBlank() || isUnresolvedPlaceholder(environment, value)) {
            throw missingProperty(name);
        }
        return value;
    }

    private static String rawProperty(Environment environment, String name) {
        if (environment instanceof ConfigurableEnvironment configurableEnvironment) {
            for (PropertySource<?> propertySource : configurableEnvironment.getPropertySources()) {
                Object value = propertySource.getProperty(name);
                if (value != null) return value.toString();
            }
        }
        return null;
    }

    private static IllegalStateException missingProperty(String name) {
        return new IllegalStateException(name + " is required for the production PostgreSQL datasource.");
    }

    private static boolean isEntirePlaceholder(String value) {
        return value.startsWith("${") && value.endsWith("}")
            && !value.substring(2, value.length() - 1).contains("${");
    }

    private static boolean isUnresolvedPlaceholder(Environment environment, String value) {
        if (!isEntirePlaceholder(value)) return false;
        String placeholder = value.substring(2, value.length() - 1);
        if (placeholder.contains(":")) return false;
        return environment.getProperty(placeholder) == null;
    }
}
