#include <jni.h>
#include <algorithm>
#include <cstddef>
#include <cstdint>

extern "C" {
uint64_t polyth_link_client_new(const char* data_dir, const char* web_dist);
void polyth_link_client_free(uint64_t handle);
char* polyth_link_invoke(uint64_t handle, const char* method, const char* params_json,
                         const uint8_t* identity_secret, size_t identity_secret_len);
size_t polyth_link_generate_identity_secret(uint8_t* out, size_t out_len);
char* polyth_link_ticket_host_id(const char* ticket);
void polyth_link_string_free(char* value);
}

namespace {
class UtfChars {
 public:
  UtfChars(JNIEnv* env, jstring value) : env_(env), value_(value) {
    chars_ = value == nullptr ? nullptr : env_->GetStringUTFChars(value, nullptr);
  }
  ~UtfChars() {
    if (chars_ != nullptr) env_->ReleaseStringUTFChars(value_, chars_);
  }
  const char* get() const { return chars_; }
 private:
  JNIEnv* env_;
  jstring value_;
  const char* chars_ = nullptr;
};

jstring owned_string(JNIEnv* env, char* value) {
  if (value == nullptr) return nullptr;
  jstring result = env->NewStringUTF(value);
  polyth_link_string_free(value);
  return result;
}
}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_com_polyth_mobile_PolythLinkRust_clientNew(JNIEnv* env, jclass, jstring data_dir, jstring web_dist) {
  UtfChars data(env, data_dir);
  UtfChars web(env, web_dist);
  if (data.get() == nullptr || web.get() == nullptr) return 0;
  return static_cast<jlong>(polyth_link_client_new(data.get(), web.get()));
}

extern "C" JNIEXPORT void JNICALL
Java_com_polyth_mobile_PolythLinkRust_clientFree(JNIEnv*, jclass, jlong handle) {
  polyth_link_client_free(static_cast<uint64_t>(handle));
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_polyth_mobile_PolythLinkRust_invoke(JNIEnv* env, jclass, jlong handle, jstring method,
                                              jstring params_json, jbyteArray identity_secret) {
  UtfChars method_chars(env, method);
  UtfChars params_chars(env, params_json);
  if (method_chars.get() == nullptr || params_chars.get() == nullptr) return nullptr;

  uint8_t secret[32] = {};
  const uint8_t* secret_ptr = nullptr;
  size_t secret_len = 0;
  if (identity_secret != nullptr) {
    const jsize length = env->GetArrayLength(identity_secret);
    secret_len = static_cast<size_t>(length);
    if (length == static_cast<jsize>(sizeof(secret))) {
      env->GetByteArrayRegion(identity_secret, 0, length, reinterpret_cast<jbyte*>(secret));
      if (env->ExceptionCheck()) {
        std::fill(secret, secret + sizeof(secret), 0);
        return nullptr;
      }
      secret_ptr = secret;
    }
  }

  char* result = polyth_link_invoke(
      static_cast<uint64_t>(handle), method_chars.get(), params_chars.get(), secret_ptr, secret_len);
  std::fill(secret, secret + sizeof(secret), 0);
  return owned_string(env, result);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_polyth_mobile_PolythLinkRust_generateIdentitySecret(JNIEnv* env, jclass) {
  uint8_t secret[32] = {};
  if (polyth_link_generate_identity_secret(secret, sizeof(secret)) != sizeof(secret)) {
    std::fill(secret, secret + sizeof(secret), 0);
    return nullptr;
  }
  jbyteArray result = env->NewByteArray(sizeof(secret));
  if (result != nullptr) {
    env->SetByteArrayRegion(result, 0, sizeof(secret), reinterpret_cast<const jbyte*>(secret));
  }
  std::fill(secret, secret + sizeof(secret), 0);
  return result;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_polyth_mobile_PolythLinkRust_ticketHostId(JNIEnv* env, jclass, jstring ticket) {
  UtfChars value(env, ticket);
  if (value.get() == nullptr) return nullptr;
  return owned_string(env, polyth_link_ticket_host_id(value.get()));
}
