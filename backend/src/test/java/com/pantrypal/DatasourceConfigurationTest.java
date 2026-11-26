package com.pantrypal;

import org.junit.jupiter.api.Test;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.io.ClassPathResource;
import org.springframework.mock.env.MockEnvironment;
import static org.assertj.core.api.Assertions.assertThat;

class DatasourceConfigurationTest {
    @Test
    void explicitDbUrlWinsWithoutSplitVariablesAndPreservesSsl() throws Exception {
        var environment = productionEnvironment();
        environment.setProperty("DB_URL", "jdbc:postgresql://neon.example.test/pantrypal?sslmode=require&channelBinding=require");

        assertThat(resolveDatasourceUrl(environment))
            .isEqualTo("jdbc:postgresql://neon.example.test/pantrypal?sslmode=require&channelBinding=require");
    }

    @Test
    void splitVariablesRemainTheFallback() throws Exception {
        var environment = productionEnvironment();
        environment.setProperty("DB_URL", "");
        environment.setProperty("DB_HOST", "render.example.test");
        environment.setProperty("DB_PORT", "5432");
        environment.setProperty("DB_NAME", "pantrypal");

        assertThat(ProductionDatasourceConfiguration.resolveUrl(environment))
            .isEqualTo("jdbc:postgresql://render.example.test:5432/pantrypal");
    }

    @Test
    void explicitDbUrlWinsWhenSplitVariablesAreAlsoPresent() throws Exception {
        var environment = productionEnvironment();
        environment.setProperty("DB_URL", "jdbc:postgresql://neon.example.test/pantrypal?sslmode=require");
        environment.setProperty("DB_HOST", "render.example.test");
        environment.setProperty("DB_PORT", "5432");
        environment.setProperty("DB_NAME", "renderdb");

        assertThat(ProductionDatasourceConfiguration.resolveUrl(environment))
            .isEqualTo("jdbc:postgresql://neon.example.test/pantrypal?sslmode=require");
    }

    @Test
    void commandLineSpringDatasourceUrlRemainsAnExplicitOverride() {
        var environment = new MockEnvironment()
            .withProperty("spring.datasource.url", "jdbc:postgresql://operator.example.test/pantrypal?sslmode=require");

        assertThat(ProductionDatasourceConfiguration.resolveUrl(environment))
            .isEqualTo("jdbc:postgresql://operator.example.test/pantrypal?sslmode=require");
    }

    @Test
    void localProfileKeepsFileBackedH2() throws Exception {
        var loader = new YamlPropertySourceLoader();
        var source = loader.load("local", new ClassPathResource("application-local.yml")).get(0);
        var environment = new MockEnvironment().withProperty("PANTRYPAL_DATA_DIR", "target/test-data");
        environment.getPropertySources().addFirst(source);

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

    private MockEnvironment productionEnvironment() throws Exception {
        var loader = new YamlPropertySourceLoader();
        var source = loader.load("production", new ClassPathResource("application-production.yml")).get(0);
        var environment = new MockEnvironment();
        environment.getPropertySources().addFirst(source);
        return environment;
    }

    private String resolveDatasourceUrl(MockEnvironment environment) {
        return ProductionDatasourceConfiguration.resolveUrl(environment);
    }
}
