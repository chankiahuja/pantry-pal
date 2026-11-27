package com.pantrypal;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.annotation.Transactional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc(addFilters = false)
@Transactional
class ShoppingStoreResponseContractTest {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper objectMapper;
    @Autowired PantryRepository repository;

    @Test
    void shoppingStoreResponsesAreExactAndAccountScoped() throws Exception {
        long alice = account("shopping-store-alice");
        long bob = account("shopping-store-bob");
        var alicePrincipal = new TestingAuthenticationToken(Long.toString(alice), null);
        var bobPrincipal = new TestingAuthenticationToken(Long.toString(bob), null);

        JsonNode initial = body(mvc.perform(get("/api/shopping-store").principal(alicePrincipal))
            .andExpect(status().isOk()).andReturn());
        assertFields(initial, "storeName", "whatsappNumber");
        assertThat(initial.get("storeName").isNull()).isTrue();
        assertThat(initial.get("whatsappNumber").isNull()).isTrue();

        JsonNode saved = body(mvc.perform(patch("/api/shopping-store").principal(alicePrincipal)
                .contentType("application/json")
                .content("{\"storeName\":\"Sharma Kirana\",\"whatsappNumber\":\"98765 43210\"}"))
            .andExpect(status().isOk()).andReturn());
        assertFields(saved, "storeName", "whatsappNumber");
        assertThat(saved.get("storeName").asText()).isEqualTo("Sharma Kirana");
        assertThat(saved.get("whatsappNumber").asText()).isEqualTo("+919876543210");

        JsonNode fresh = body(mvc.perform(get("/api/shopping-store").principal(alicePrincipal))
            .andExpect(status().isOk()).andReturn());
        assertThat(fresh).isEqualTo(saved);

        JsonNode bobInitial = body(mvc.perform(get("/api/shopping-store").principal(bobPrincipal))
            .andExpect(status().isOk()).andReturn());
        assertFields(bobInitial, "storeName", "whatsappNumber");
        assertThat(bobInitial.get("storeName").isNull()).isTrue();
        assertThat(bobInitial.get("whatsappNumber").isNull()).isTrue();

        mvc.perform(patch("/api/shopping-store").principal(bobPrincipal)
                .contentType("application/json")
                .content("{\"storeName\":\"Bob Store\",\"whatsappNumber\":\"+1 (415) 555-0123\"}"))
            .andExpect(status().isOk());
        JsonNode aliceAfterBob = body(mvc.perform(get("/api/shopping-store").principal(alicePrincipal))
            .andExpect(status().isOk()).andReturn());
        assertThat(aliceAfterBob).isEqualTo(saved);
    }

    @Test
    void backendPhoneNormalizationMatchesDemoCases() {
        assertThat(PantryService.normalizeWhatsAppNumber("98765 43210")).isEqualTo("+919876543210");
        assertThat(PantryService.normalizeWhatsAppNumber("+1 (415) 555-0123")).isEqualTo("+14155550123");
        assertThatThrownBy(() -> PantryService.normalizeWhatsAppNumber("+00000000"))
            .hasMessageContaining("whatsappNumber must be a valid phone number");
        assertThatThrownBy(() -> PantryService.normalizeWhatsAppNumber("+1 415 ABC 0123"))
            .hasMessageContaining("whatsappNumber must be a valid phone number");
    }

    private long account(String prefix) {
        return repository.insert("accounts", Map.of(
            "email", prefix + "-" + System.nanoTime() + "@example.com",
            "display_name", prefix));
    }

    private JsonNode body(MvcResult result) throws Exception {
        return objectMapper.readTree(result.getResponse().getContentAsString());
    }

    private void assertFields(JsonNode node, String... fields) {
        Set<String> actual = new HashSet<>();
        node.fieldNames().forEachRemaining(actual::add);
        assertThat(actual).containsExactlyInAnyOrder(fields);
    }
}
