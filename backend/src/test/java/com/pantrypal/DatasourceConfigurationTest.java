package com.pantrypal;

import org.junit.jupiter.api.Test;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.mock.env.MockEnvironment;
import java.util.HashMap;
import java.util.Map;
import static org.assertj.core.api.Assertions.assertThat;

class DatasourceConfigurationTest {
    @Test
    void explicitDbUrlWinsWithoutSplitVariablesAndPreservesSsl() throws Exception {
        var environment = productionEnvironment(Map.of(
            "DB_URL", "jdbc:postgresql://neon.example.test/pantrypal?sslmode=require&channelBinding=require",
            "spring.datasource.username", "neon-user",
            "spring.datasource.password", "neon-password"));

        assertThat(ProductionDatasourceConfiguration.resolveUrl(environment))
            .isEqualTo("jdbc:postgresql://neon.example.test/pantrypal?sslmode=require&channelBinding=require");
    }

    @Test
    void directSpringDatasourcePropertiesWorkWithoutDbVariables() throws Exception {
        var environment = productionEnvironment(Map.of(
            "spring.datasource.url", "jdbc:postgresql://direct.example.test/pantrypal?sslmode=require",
            "spring.datasource.username", "direct-user",
            "spring.datasource.password", "direct-password"));

        var dataSource = (com.zaxxer.hikari.HikariDataSource)
            new ProductionDatasourceConfiguration().productionDataSource(environment);

        assertThat(dataSource.getJdbcUrl()).isEqualTo("jdbc:postgresql://direct.example.test/pantrypal?sslmode=require");
        assertThat(dataSource.getUsername()).isEqualTo("direct-user");
        assertThat(dataSource.getPassword()).isEqualTo("direct-password");
        dataSource.close();
    }

    @Test
    void directSpringCredentialsWinOverRenderCredentialMappings() throws Exception {
        var environment = productionEnvironment(Map.of(
            "DB_HOST", "render.example.test",
            "DB_PORT", "5432",
            "DB_NAME", "renderdb",
            "DB_USER", "render-user",
            "DB_PASSWORD", "render-password",
            "spring.datasource.url", "jdbc:postgresql://direct.example.test/pantrypal",
            "spring.datasource.username", "direct-user",
            "spring.datasource.password", "direct-password"));

        var dataSource = (com.zaxxer.hikari.HikariDataSource)
            new ProductionDatasourceConfiguration().productionDataSource(environment);

        assertThat(dataSource.getUsername()).isEqualTo("direct-user");
        assertThat(dataSource.getPassword()).isEqualTo("direct-password");
        dataSource.close();
    }

    @Test
    void literalPasswordContainingPlaceholderSyntaxIsPreserved() throws Exception {
        var environment = productionEnvironment(Map.of(
            "spring.datasource.url", "jdbc:postgresql://direct.example.test/pantrypal",
            "spring.datasource.username", "direct-user",
            "spring.datasource.password", "literal-${token}-password"));

        var dataSource = (com.zaxxer.hikari.HikariDataSource)
            new ProductionDatasourceConfiguration().productionDataSource(environment);

        assertThat(dataSource.getPassword()).isEqualTo("literal-${token}-password");
        dataSource.close();
    }

    @Test
    void directPasswordThatIsOnlyAPlaceholderIsLiteralWhenReferencedPropertyIsPresent() throws Exception {
        var environment = productionEnvironment(Map.of(
            "spring.datasource.url", "jdbc:postgresql://direct.example.test/pantrypal",
            "spring.datasource.username", "direct-user",
            "spring.datasource.password", "${token}",
            "token", "resolved-value"));

        var dataSource = (com.zaxxer.hikari.HikariDataSource)
            new ProductionDatasourceConfiguration().productionDataSource(environment);

        assertThat(dataSource.getPassword()).isEqualTo("${token}");
        dataSource.close();
    }

    @Test
    void directPasswordThatIsOnlyAPlaceholderIsLiteralWhenReferencedPropertyIsAbsent() throws Exception {
        var environment = productionEnvironment(Map.of(
            "spring.datasource.url", "jdbc:postgresql://direct.example.test/pantrypal",
            "spring.datasource.username", "direct-user",
            "spring.datasource.password", "${token}"));

        var dataSource = (com.zaxxer.hikari.HikariDataSource)
            new ProductionDatasourceConfiguration().productionDataSource(environment);

        assertThat(dataSource.getPassword()).isEqualTo("${token}");
        dataSource.close();
    }

    @Test
    void yamlPasswordMappingPreservesPlaceholderPasswordWhenReferencedPropertyIsPresent() throws Exception {
        var environment = productionEnvironment(Map.of(
            "spring.datasource.url", "jdbc:postgresql://direct.example.test/pantrypal",
            "DB_USER", "mapped-user",
            "DB_PASSWORD", "${token}",
            "token", "resolved-value"));

        var dataSource = (com.zaxxer.hikari.HikariDataSource)
            new ProductionDatasourceConfiguration().productionDataSource(environment);

        assertThat(dataSource.getPassword()).isEqualTo("${token}");
        dataSource.close();
    }

    @Test
    void yamlPasswordMappingPreservesPlaceholderPasswordWhenReferencedPropertyIsAbsent() throws Exception {
        var environment = productionEnvironment(Map.of(
            "spring.datasource.url", "jdbc:postgresql://direct.example.test/pantrypal",
            "DB_USER", "mapped-user",
            "DB_PASSWORD", "${token}"));

        var dataSource = (com.zaxxer.hikari.HikariDataSource)
            new ProductionDatasourceConfiguration().productionDataSource(environment);

        assertThat(dataSource.getPassword()).isEqualTo("${token}");
        dataSource.close();
    }

    @Test
    void missingCredentialsFailWithoutExposingSecretValues() throws Exception {
        var environment = productionEnvironment(Map.of(
            "DB_HOST", "render.example.test", "DB_PORT", "5432", "DB_NAME", "pantrypal"));

        assertThat(org.assertj.core.api.Assertions.catchThrowable(() ->
            new ProductionDatasourceConfiguration().productionDataSource(environment)))
            .isInstanceOf(IllegalStateException.class)
            .hasMessage("spring.datasource.username is required for the production PostgreSQL datasource.")
            .hasMessageNotContaining("password")
            .hasMessageNotContaining("render");
    }

    @Test
    void legacyRenderCredentialMappingsRemainEffective() throws Exception {
        var environment = productionEnvironment(Map.of(
            "DB_HOST", "render.example.test",
            "DB_PORT", "5432",
            "DB_NAME", "pantrypal",
            "DB_USER", "render-user",
            "DB_PASSWORD", "render-password"));

        var dataSource = (com.zaxxer.hikari.HikariDataSource)
            new ProductionDatasourceConfiguration().productionDataSource(environment);

        assertThat(dataSource.getJdbcUrl()).isEqualTo("jdbc:postgresql://render.example.test:5432/pantrypal");
        assertThat(dataSource.getUsername()).isEqualTo("render-user");
        assertThat(dataSource.getPassword()).isEqualTo("render-password");
        dataSource.close();
    }

    @Test
    void explicitDbUrlWinsWhenSplitVariablesAreAlsoPresent() throws Exception {
        var environment = productionEnvironment(Map.of(
            "DB_URL", "jdbc:postgresql://neon.example.test/pantrypal?sslmode=require",
            "spring.datasource.url", "jdbc:postgresql://operator.example.test/pantrypal?sslmode=verify-full",
            "DB_HOST", "render.example.test",
            "DB_PORT", "5432",
            "DB_NAME", "renderdb"));

        assertThat(ProductionDatasourceConfiguration.resolveUrl(environment))
            .isEqualTo("jdbc:postgresql://neon.example.test/pantrypal?sslmode=require");
    }

    @Test
    void commandLineSpringDatasourceUrlRemainsAnExplicitOverride() {
        var environment = new MockEnvironment();
        environment.getPropertySources().addFirst(new MapPropertySource("test", Map.of(
            "spring.datasource.url", "jdbc:postgresql://operator.example.test/pantrypal?sslmode=require")));

        assertThat(ProductionDatasourceConfiguration.resolveUrl(environment))
            .isEqualTo("jdbc:postgresql://operator.example.test/pantrypal?sslmode=require");
    }

    @Test
    void unsetDbUrlUsesSplitFallback() throws Exception {
        assertThat(ProductionDatasourceConfiguration.resolveUrl(productionEnvironment(Map.of(
            "DB_HOST", "render.example.test", "DB_PORT", "5432", "DB_NAME", "pantrypal"))))
            .isEqualTo("jdbc:postgresql://render.example.test:5432/pantrypal");
    }

    @Test
    void emptyDbUrlUsesSplitFallback() throws Exception {
        assertThat(ProductionDatasourceConfiguration.resolveUrl(productionEnvironment(Map.of(
            "DB_URL", "", "DB_HOST", "render.example.test", "DB_PORT", "5432", "DB_NAME", "pantrypal"))))
            .isEqualTo("jdbc:postgresql://render.example.test:5432/pantrypal");
    }

    @Test
    void whitespaceDbUrlUsesSplitFallback() throws Exception {
        assertThat(ProductionDatasourceConfiguration.resolveUrl(productionEnvironment(Map.of(
            "DB_URL", "  \t", "DB_HOST", "render.example.test", "DB_PORT", "5432", "DB_NAME", "pantrypal"))))
            .isEqualTo("jdbc:postgresql://render.example.test:5432/pantrypal");
    }

    @Test
    void localProfileKeepsFileBackedH2() throws Exception {
        var loader = new YamlPropertySourceLoader();
        var source = loader.load("local", new ClassPathResource("application-local.yml")).get(0);
        var environment = new MockEnvironment();
        environment.getPropertySources().addFirst(new MapPropertySource("test", Map.of("PANTRYPAL_DATA_DIR", "target/test-data")));
        environment.getPropertySources().addLast(source);

        assertThat(environment.getProperty("spring.datasource.url"))
            .isEqualTo("jdbc:h2:file:target/test-data/pantrypal;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_ON_EXIT=FALSE");
    }

    @Test
    void flywayMigrationResourcesRemainVersionedAndPresent() {
        assertThat(new ClassPathResource("db/migration/V1__pantry.sql").exists()).isTrue();
        assertThat(new ClassPathResource("db/migration/V2__inventory_adjustments.sql").exists()).isTrue();
        assertThat(new ClassPathResource("db/migration/V3__inventory_undo.sql").exists()).isTrue();
        assertThat(new ClassPathResource("db/migration/V4__email_authentication.sql").exists()).isTrue();
        assertThat(new ClassPathResource("db/migration/V5__email_challenge_intent.sql").exists()).isTrue();
        assertThat(new ClassPathResource("db/migration/V6__account_scoped_pantry.sql").exists()).isTrue();
        assertThat(new ClassPathResource("db/migration/V7__account_session_integrity.sql").exists()).isTrue();
    }

    private ConfigurableEnvironment productionEnvironment(Map<String, String> properties) throws Exception {
        var loader = new YamlPropertySourceLoader();
        var source = loader.load("production", new ClassPathResource("application-production.yml")).get(0);
        var environment = new MockEnvironment();
        environment.getPropertySources().addFirst(new MapPropertySource("test", new HashMap<>(properties)));
        environment.getPropertySources().addLast(source);
        return environment;
    }
}
