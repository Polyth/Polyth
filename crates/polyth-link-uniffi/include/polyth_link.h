#ifndef POLYTH_LINK_H
#define POLYTH_LINK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

uint32_t polyth_link_abi_version(void);

uint64_t polyth_link_client_new(const char *data_dir, const char *web_dist);
void polyth_link_client_free(uint64_t handle);

char *polyth_link_invoke(
    uint64_t handle,
    const char *method,
    const char *params_json,
    const uint8_t *identity_secret,
    size_t identity_secret_len
);

size_t polyth_link_generate_identity_secret(uint8_t *out, size_t out_len);
char *polyth_link_identity_endpoint_id(const uint8_t *secret, size_t secret_len);
void polyth_link_string_free(char *value);

#ifdef __cplusplus
}
#endif

#endif
